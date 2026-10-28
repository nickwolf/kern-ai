import { tool } from "ai";
import type { KernConfig } from "../../config.js";
import { z } from "zod";
import type { RecallIndex, RecallResult } from "./recall.js";
import { currentTurn, CORE_SCOPE } from "../../turn-context.js";
import { recallAccess } from "./access.js";

let _recallIndex: RecallIndex | null = null;
let _config: Pick<KernConfig, "sessionMode" | "userAliases"> = { sessionMode: "shared", userAliases: {} };
// Context-window bounds per session, so concurrent sessions don't overwrite
// each other's. The last session to build context is the fallback when a
// tool runs outside a turn.
const _contextTrimmed = new Map<string, number>();
let _lastContextSessionId: string | null = null;

export function setRecallIndex(index: RecallIndex | null, config?: Pick<KernConfig, "sessionMode" | "userAliases">) {
  _recallIndex = index;
  if (config) _config = config;
}

export function setContextBounds(sessionId: string, trimmedCount: number) {
  _contextTrimmed.set(sessionId, trimmedCount);
  _lastContextSessionId = sessionId;
}

/**
 * Search limited to what the current turn may read (see recallAccess). The
 * vector index can't filter by session, so fetch extra and filter.
 */
export async function scopedSearch(index: RecallIndex, query: string, limit: number): Promise<RecallResult[]> {
  const turn = currentTurn();
  const canRead = await recallAccess(index, turn?.scope ?? CORE_SCOPE, _config, turn?.origin.interface);
  if (!canRead) return index.search(query, limit);
  const results = await index.search(query, limit * 10);
  return results.filter(canRead).slice(0, limit);
}

export const recallTool = tool({
  description:
    "Search your long-term memory for old conversations outside your current context window. " +
    "Two modes: (1) Search: provide a query to find relevant past conversations. " +
    "(2) Load: provide sessionId + messageStart + messageEnd to load raw messages around a search hit.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("Search query to find relevant past conversations"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 5)"),
    sessionId: z
      .string()
      .optional()
      .describe("Session ID to load messages from (for load mode)"),
    messageStart: z
      .number()
      .optional()
      .describe("Start message index (for load mode)"),
    messageEnd: z
      .number()
      .optional()
      .describe("End message index (for load mode)"),
    before: z
      .string()
      .optional()
      .describe("Only return results before this date (ISO 8601 or YYYY-MM-DD)"),
    after: z
      .string()
      .optional()
      .describe("Only return results after this date (ISO 8601 or YYYY-MM-DD)"),
  }),
  execute: async (args) => {
    if (!_recallIndex) {
      return "Recall is not available.";
    }

    try {
      // Load mode
      if (args.sessionId && args.messageStart !== undefined && args.messageEnd !== undefined) {
        const turn = currentTurn();
        const canRead = await recallAccess(_recallIndex, turn?.scope ?? CORE_SCOPE, _config, turn?.origin.interface);
        if (canRead && !canRead({ session_id: args.sessionId, msg_start: args.messageStart, msg_end: args.messageEnd })) {
          return "Those messages are not readable from this session (another user's conversation, or a channel this user is not in).";
        }
        return await _recallIndex.loadMessages(args.sessionId, args.messageStart, args.messageEnd);
      }

      // Search mode
      if (args.query) {
        let results = await scopedSearch(_recallIndex, args.query, (args.limit || 5) * 3); // fetch extra for filtering
        
        // Apply date filters. `recall.db` stores UTC-normalized timestamps, so
        // lexicographic string comparison is correct.
        if (args.after) {
          const after = new Date(args.after).toISOString();
          results = results.filter((r) => r.timestamp >= after);
        }
        if (args.before) {
          const before = new Date(args.before).toISOString();
          results = results.filter((r) => r.timestamp <= before);
        }

        // Filter out chunks already in context window
        const contextSessionId = currentTurn()?.sessionId ?? _lastContextSessionId;
        const contextTrimmedCount = contextSessionId ? _contextTrimmed.get(contextSessionId) ?? 0 : 0;
        if (contextSessionId && contextTrimmedCount > 0) {
          results = results.filter(r =>
            !(r.session_id === contextSessionId && r.msg_end >= contextTrimmedCount)
          );
        }
        
        results = results.slice(0, args.limit || 5);
        if (results.length === 0) {
          return "No relevant past conversations found.";
        }

        return results
          .map((r, i) => {
            return [
              `--- Result ${i + 1} (distance: ${r.distance.toFixed(3)}) ---`,
              `Session: ${r.session_id}`,
              `Messages: ${r.msg_start}-${r.msg_end}`,
              `Time: ${r.timestamp}`,
              ``,
              r.text,
            ].join("\n");
          })
          .join("\n\n");
      }

      return "Provide either a 'query' for search or 'sessionId'+'messageStart'+'messageEnd' to load messages.";
    } catch (err: any) {
      return `Recall error: ${err.message}`;
    }
  },
});
