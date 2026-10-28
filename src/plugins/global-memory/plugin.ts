import { tool } from "ai";
import { z } from "zod";
import type { KernPlugin, PluginContext, ContextInjection } from "../types.js";
import { isPerUserMode, CORE_KEY } from "../../session-router.js";
import { writeProposal, listPending, resolveProposal, type PendingProposal } from "./inbox.js";
import { commitMemory, keepUsersOutOfGit } from "./git.js";
import { isOperatorTurn } from "../../config.js";
import { log } from "../../log.js";

/**
 * Global memory plugin — per-user session mode only.
 *
 * User sessions can't edit global memory. They call propose_global, which
 * drops a proposal into .kern/global-inbox/. The core session sees pending
 * proposals in its operator and automatic turns (heartbeats, review turns)
 * and settles each with resolve_proposal. With globalReviewOnPropose the core
 * is woken right away instead of at the next heartbeat.
 *
 * Commits go through commit_memory rather than the shell: automatic and group
 * turns run without one (see turnToolScope), so a proposal can't talk the
 * reviewer into running commands. Each session stages only memory it owns.
 */

let _ctx: PluginContext | null = null;

const MAX_LISTED = 20;

function age(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "age unknown";
  return minutes < 90 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
}

function formatPending(pending: PendingProposal[]): string {
  const lines = pending.slice(0, MAX_LISTED).map((p) => `- .kern/global-inbox/${p.file} (from ${p.from}, target ${p.target}, ${age(p.proposed)})`);
  if (pending.length > MAX_LISTED) lines.push(`- ... and ${pending.length - MAX_LISTED} more`);
  return lines.join("\n");
}

const PROPOSALS_PER_HOUR = 10;
const recentProposals = new Map<string, number[]>();

/** Records a proposal for `key` unless it already made PROPOSALS_PER_HOUR in the last hour. */
function underRateLimit(key: string, now = Date.now()): boolean {
  const recent = (recentProposals.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PROPOSALS_PER_HOUR) return false;
  recent.push(now);
  recentProposals.set(key, recent);
  return true;
}

/**
 * Wake the core for a review turn. If the turn ends with the proposal still
 * pending (the model stopped early), log it and ask once more; after that it
 * waits for the next heartbeat or the operator.
 */
function requestReview(ctx: PluginContext, file: string, from: string, retry = true): void {
  const origin = { interface: "system", channel: "global-inbox", userId: "system", sessionKey: CORE_KEY };
  const text = retry
    ? `[global-inbox] new proposal .kern/global-inbox/${file} from ${from}`
    : `[global-inbox] .kern/global-inbox/${file} is still pending. Settle it with resolve_proposal now.`;
  ctx.announce(text, origin).then(async () => {
    if (!(await listPending(ctx.agentDir)).some((p) => p.file === file)) return;
    log.warn("global-memory", `review turn ended with ${file} unsettled${retry ? "; asking again" : "; waiting for the next heartbeat or /inbox"}`);
    if (retry) requestReview(ctx, file, from, false);
  }).catch((err) => log.error("global-memory", `review turn failed: ${err.message}`));
}

export const proposeGlobalTool = tool({
  description: [
    "Propose a change to global memory, which is shared by every user and kept by the core session.",
    "Use it for facts, decisions or corrections that everyone should know. Never include this user's private details.",
    "The core session reviews proposals and applies or rejects them, so the change is not immediate.",
  ].join(" "),
  inputSchema: z.object({
    target: z.string().describe("Global file the change belongs in, e.g. knowledge/network.md or KNOWLEDGE.md"),
    change: z.string().describe("The change to make, written so it can be applied without this conversation"),
    rationale: z.string().describe("Why this is true and useful to everyone (source, date)"),
  }),
  execute: async ({ target, change, rationale }) => {
    if (!_ctx) return "Global memory is not available.";
    const scope = _ctx.scope();
    if (scope.kind === "core") {
      return "This is the core session: edit global memory directly instead of proposing.";
    }
    if (!underRateLimit(scope.key)) {
      return `Not queued: this user has made ${PROPOSALS_PER_HOUR} proposals in the last hour. Tell them to try again later.`;
    }
    const file = await writeProposal(_ctx.agentDir, {
      from: scope.key,
      sessionId: _ctx.sessionId(),
      target,
      change,
      rationale,
      origin: _ctx.origin(),
    });
    log("global-memory", `proposal ${file} from ${scope.key} → ${target}`);

    if (_ctx.config.globalReviewOnPropose) requestReview(_ctx, file, scope.key);
    const when = _ctx.config.globalReviewOnPropose
      ? "shortly"
      : _ctx.config.heartbeatInterval > 0 ? `within about ${_ctx.config.heartbeatInterval} minutes` : "when the operator next reviews the inbox";
    return `Queued for review (${file}). Not shared yet: the core session will review it ${when}. Tell the user it is pending.`;
  },
});

/** Core turns that review the inbox: the operator's and automatic ones, not group channels. */
function reviewsInbox(ctx: PluginContext): boolean {
  if (ctx.scope().kind !== "core") return false;
  const iface = ctx.origin()?.interface;
  return iface === "system" || isOperatorTurn(ctx.config, ctx.scope(), iface);
}

/**
 * What the core commits: global memory, never runtime state. Personal memory
 * (users/) is gitignored, and commitMemory never commits it either way.
 */
const CORE_PATHSPECS = [".", ":(exclude).kern"];

export const resolveProposalTool = tool({
  description: [
    "Settle a global memory proposal from .kern/global-inbox/ (core session).",
    "Apply accepted changes to the global files with write/edit first, then call this.",
    "It archives the proposal with your decision and commits global memory.",
  ].join(" "),
  inputSchema: z.object({
    file: z.string().describe("Proposal file name in .kern/global-inbox/, e.g. 2026-10-28T14-43-12-946Z-slack_U1.md"),
    decision: z.enum(["applied", "rejected"]),
    note: z.string().describe("One line: what you changed, or why you rejected it"),
  }),
  execute: async ({ file, decision, note }) => {
    if (!_ctx) return "Global memory is not available.";
    if (!reviewsInbox(_ctx)) return "Only the core session reviews global memory proposals.";
    const resolved = await resolveProposal(_ctx.agentDir, file, decision, note);
    if (!resolved) return `No pending proposal named ${file} in .kern/global-inbox/.`;
    log("global-memory", `proposal ${file} from ${resolved.from} ${decision}`);
    const committed = await commitMemory(_ctx.agentDir, CORE_PATHSPECS, `global memory: ${decision} proposal from ${resolved.from}: ${note.trim().slice(0, 72)}`)
      .catch((err) => `Commit failed: ${err.message}`);

    // Tell the proposer's session how it went. Not awaited: that session's
    // turn may need a concurrency slot this one is holding.
    // Its own channel label, so it runs as a separate turn instead of being
    // folded into whatever the user is in the middle of; delivery still goes
    // to their DM through the chat ID.
    const origin = resolved.origin;
    if (origin?.sessionKey && origin.sessionKey !== CORE_KEY) {
      const when = resolved.proposed ? ` on ${resolved.proposed.slice(0, 10)}` : "";
      const outcome = `[global-inbox] About the change this user agreed to share${when}: the proposal to update ${resolved.target} was ${decision}. ${note.trim()}`;
      _ctx.announce(outcome, { ...origin, channel: "global-inbox" })
        .catch((err) => log.error("global-memory", `outcome notice failed: ${err.message}`));
    }
    return `Proposal ${decision} and archived. ${committed}`;
  },
});

export const commitMemoryTool = tool({
  description: [
    "Commit (and push, if the agent repo has an origin) global memory (core session).",
    "Personal memory under users/ is never committed: it is saved on disk as soon as it is written.",
  ].join(" "),
  inputSchema: z.object({
    message: z.string().describe("Commit message"),
  }),
  execute: async ({ message }) => {
    if (!_ctx) return "Global memory is not available.";
    if (_ctx.scope().kind === "user") {
      return "Nothing to do: personal memory is saved on disk as soon as you write it, and is kept out of git so it stays private.";
    }
    return commitMemory(_ctx.agentDir, CORE_PATHSPECS, message).catch((err) => `Commit failed: ${err.message}`);
  },
});

export const globalMemoryPlugin: KernPlugin = {
  name: "global-memory",

  enabled: (ctx) => isPerUserMode(ctx.config),

  tools: {
    propose_global: proposeGlobalTool,
    resolve_proposal: resolveProposalTool,
    commit_memory: commitMemoryTool,
  },

  toolDescriptions: {
    propose_global: "propose a change to shared global memory for the core session to review (user sessions)",
    resolve_proposal: "archive a reviewed global memory proposal and commit (core session)",
    commit_memory: "commit and push the memory this session owns",
  },

  async onStartup(ctx) {
    _ctx = ctx;
    if (ctx.config.heartbeatInterval <= 0 && !ctx.config.globalReviewOnPropose) {
      log.warn("global-memory", "heartbeats are off and globalReviewOnPropose is false: proposals will wait until the operator reviews them (/inbox)");
    }
    await keepUsersOutOfGit(ctx.agentDir).catch((err) => log.error("global-memory", `could not update .gitignore: ${err.message}`));
  },

  async onShutdown() {
    _ctx = null;
  },

  async onBeforeContext(_info, ctx): Promise<ContextInjection | null> {
    if (!reviewsInbox(ctx)) return null;
    const pending = await listPending(ctx.agentDir);
    if (pending.length === 0) return null;
    // Automatic turns (heartbeat, review) do the reviewing. The operator gets
    // a reminder, so an unrelated question doesn't turn into a review.
    if (ctx.origin()?.interface !== "system") {
      return {
        label: "global-inbox",
        content: `${pending.length} global memory proposal(s) pending. Review them only if the operator asks (/inbox lists them).`,
        placement: "system",
      };
    }
    return {
      label: "global-inbox",
      content: `${pending.length} pending proposal(s) to review. Each was written by a user's own session, with that user's agreement:\n${formatPending(pending)}`,
      placement: "system",
    };
  },

  commands: {
    "/inbox": {
      description: "list global memory proposals waiting for review",
      handler: async (ctx) => {
        const pending = await listPending(ctx.agentDir);
        return pending.length === 0 ? "Global inbox is empty." : formatPending(pending);
      },
    },
  },
};
