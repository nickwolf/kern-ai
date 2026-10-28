import { tool } from "ai";
import { z } from "zod";
import type { KernPlugin, PluginContext, ContextInjection } from "../types.js";
import { isPerUserMode, CORE_KEY } from "../../session-router.js";
import { writeProposal, listPending, resolveProposal, type PendingProposal } from "./inbox.js";
import { commitMemory } from "./git.js";
import { isOperatorTurn } from "../../config.js";
import { userMemoryRelPath } from "../../user-memory.js";
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

function formatPending(pending: PendingProposal[]): string {
  const lines = pending.slice(0, MAX_LISTED).map((p) => `- .kern/global-inbox/${p.file} (from ${p.from}, target ${p.target})`);
  if (pending.length > MAX_LISTED) lines.push(`- ... and ${pending.length - MAX_LISTED} more`);
  return lines.join("\n");
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
    const file = await writeProposal(_ctx.agentDir, {
      from: scope.key,
      sessionId: _ctx.sessionId(),
      target,
      change,
      rationale,
    });
    log("global-memory", `proposal ${file} from ${scope.key} → ${target}`);

    if (_ctx.config.globalReviewOnPropose) {
      const origin = { interface: "system", channel: "global-inbox", userId: "system", sessionKey: CORE_KEY };
      _ctx.announce(`[global-inbox] new proposal .kern/global-inbox/${file} from ${scope.key}`, origin).catch((err) => {
        log.error("global-memory", `review turn failed: ${err.message}`);
      });
    }
    return `Proposed (${file}). The core session will review it.`;
  },
});

/** Core turns that review the inbox: the operator's and automatic ones, not group channels. */
function reviewsInbox(ctx: PluginContext): boolean {
  if (ctx.scope().kind !== "core") return false;
  const iface = ctx.origin()?.interface;
  return iface === "system" || isOperatorTurn(ctx.config, ctx.scope(), iface);
}

/** Paths a session commits: everything but personal memory for the core, its own folder for a user. */
function ownedPathspecs(ctx: PluginContext): string[] {
  const scope = ctx.scope();
  return scope.kind === "core" ? [".", ":(exclude)users"] : [userMemoryRelPath(scope.key)];
}

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
    const from = await resolveProposal(_ctx.agentDir, file, decision, note);
    if (!from) return `No pending proposal named ${file} in .kern/global-inbox/.`;
    log("global-memory", `proposal ${file} from ${from} ${decision}`);
    const committed = await commitMemory(_ctx.agentDir, ownedPathspecs(_ctx), `global memory: ${decision} proposal from ${from}: ${note.trim().slice(0, 72)}`)
      .catch((err) => `Commit failed: ${err.message}`);
    return `Proposal ${decision} and archived. ${committed}`;
  },
});

export const commitMemoryTool = tool({
  description: [
    "Commit (and push, if the agent repo has an origin) the memory this session owns:",
    "global memory from the core session, your own users/<user>/ folder from a user session.",
  ].join(" "),
  inputSchema: z.object({
    message: z.string().describe("Commit message"),
  }),
  execute: async ({ message }) => {
    if (!_ctx) return "Global memory is not available.";
    return commitMemory(_ctx.agentDir, ownedPathspecs(_ctx), message).catch((err) => `Commit failed: ${err.message}`);
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
  },

  async onShutdown() {
    _ctx = null;
  },

  async onBeforeContext(_info, ctx): Promise<ContextInjection | null> {
    if (!reviewsInbox(ctx)) return null;
    const pending = await listPending(ctx.agentDir);
    if (pending.length === 0) return null;
    return {
      label: "global-inbox",
      content: `${pending.length} pending proposal(s) to review:\n${formatPending(pending)}`,
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
