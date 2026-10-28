import { tool } from "ai";
import { z } from "zod";
import type { KernPlugin, PluginContext, ContextInjection } from "../types.js";
import { isPerUserMode, CORE_KEY } from "../../session-router.js";
import { writeProposal, listPending, type PendingProposal } from "./inbox.js";
import { log } from "../../log.js";

/**
 * Global memory plugin — per-user session mode only.
 *
 * User sessions can't edit global memory. They call propose_global, which
 * drops a proposal into .kern/global-inbox/. The core session sees pending
 * proposals in its context (every turn, including heartbeats), merges or
 * rejects them, and moves them to processed/. With globalReviewOnPropose the
 * core is woken right away instead of at the next heartbeat.
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

export const globalMemoryPlugin: KernPlugin = {
  name: "global-memory",

  enabled: (ctx) => isPerUserMode(ctx.config),

  tools: {
    propose_global: proposeGlobalTool,
  },

  toolDescriptions: {
    propose_global: "propose a change to shared global memory for the core session to review (user sessions)",
  },

  async onStartup(ctx) {
    _ctx = ctx;
  },

  async onShutdown() {
    _ctx = null;
  },

  async onBeforeContext(_info, ctx): Promise<ContextInjection | null> {
    if (ctx.scope().kind !== "core") return null;
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
