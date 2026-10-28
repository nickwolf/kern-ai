import type { KernConfig } from "../../config.js";
import { isOperatorTurn } from "../../config.js";
import type { SessionScope } from "../../turn-context.js";
import { sessionOwners } from "../../user-memory.js";
import { userIdentities } from "../../session-router.js";

export interface Envelope {
  iface: string;
  channel: string;
  userId: string;
}

export interface RecallRange {
  session_id: string;
  msg_start: number;
  msg_end: number;
}

/** What access checks need from the recall store. */
export interface EnvelopeSource {
  agentDir: string;
  /**
   * The envelope of every user message that sets the channel of messages in
   * [start, end): the last user message at or before `start`, then each user
   * message inside the range. Null for a user message without an envelope.
   */
  rangeEnvelopes(sessionId: string, start: number, end: number): (Envelope | null)[];
  /** Envelopes of user messages in the given sessions sent by userId. */
  envelopesFromUser(sessionIds: string[], userId: string): Envelope[];
}

// `[via <interface>, <channel>, user: <id>, time: <iso>]` at the very start of
// a user message (see handleTurn in app.ts). Only the leading one counts:
// anything later is text the user typed and could forge.
const ENVELOPE_RE = /^\[via ([^,\]]+?)(?:, ([^\]]*?))?, user: ([^,\]]+), time: [^\]]+\]/;

/**
 * The envelope a user message was stamped with. `content` is stored as a
 * string, or as JSON for multi-part messages (text plus attachments), where
 * the envelope starts the first text part.
 */
export function leadingEnvelope(content: string): Envelope | null {
  let text = content;
  if (content.startsWith("[{")) {
    try {
      const parts = JSON.parse(content) as { type?: string; text?: string }[];
      text = parts.find((p) => p?.type === "text")?.text ?? "";
    } catch {
      // not JSON after all; use as is
    }
  }
  const m = text.match(ENVELOPE_RE);
  return m ? { iface: m[1], channel: m[2] ?? "", userId: m[3] } : null;
}

const channelId = (e: Envelope) => `${e.iface}|${e.channel}`;

/**
 * Which recall hits the current turn may see, or null for no restriction.
 *
 * Shared mode, and the operator's turns: everything. Otherwise in per-user mode:
 * - core session: only core sessions, never a user's private sessions
 * - user session: its own sessions (including ones from before its key was
 *   aliased), plus core-session ranges where every message comes from a
 *   channel the user has posted in. A range whose channel can't be told is
 *   hidden. A user who never posted in a channel can't recall it, even as a
 *   silent member.
 */
export async function recallAccess(
  source: EnvelopeSource,
  scope: SessionScope,
  config: Pick<KernConfig, "sessionMode" | "userAliases" | "operatorUsers">,
  iface?: string,
): Promise<((r: RecallRange) => boolean) | null> {
  if (config.sessionMode !== "per-user" || isOperatorTurn(config, scope, iface)) return null;
  const owners = await sessionOwners(source.agentDir);
  // Sessions without a file (e.g. imported) predate owners: treat as core.
  const ownerOf = (id: string) => owners.get(id) ?? "core";
  if (scope.kind === "core") return (r) => ownerOf(r.session_id) === "core";

  const aliases = config.userAliases ?? {};
  const isMine = (owner: string) => owner === scope.key || aliases[owner] === scope.key;
  const coreIds = [...owners].filter(([, o]) => o === "core").map(([id]) => id);
  const memberOf = new Set<string>();
  for (const { iface: idIface, userId } of userIdentities(scope.key, aliases)) {
    for (const e of source.envelopesFromUser(coreIds, userId)) {
      if (e.iface === idIface && e.userId === userId) memberOf.add(channelId(e));
    }
  }
  return (r) => {
    const owner = ownerOf(r.session_id);
    if (isMine(owner)) return true;
    if (owner !== "core") return false;
    const envelopes = source.rangeEnvelopes(r.session_id, r.msg_start, r.msg_end);
    return envelopes.length > 0 && envelopes.every((e) => e !== null && memberOf.has(channelId(e)));
  };
}
