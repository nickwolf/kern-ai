import type { KernConfig } from "../../config.js";
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
  /** Envelopes of user messages in a session's message range (inclusive). */
  envelopesInRange(sessionId: string, start: number, end: number): Envelope[];
  /** Envelopes of user messages in the given sessions that mention userId. */
  envelopesFromUser(sessionIds: string[], userId: string): Envelope[];
}

// `[via <interface>, <channel>, user: <id>, time: <iso>]`. The channel part
// is optional; see handleTurn in app.ts.
const ENVELOPE_RE = /\[via ([^,\]]+?)(?:, ([^\]]*?))?, user: ([^,\]]+), time: [^\]]+\]/g;

export function parseEnvelopes(text: string): Envelope[] {
  const out: Envelope[] = [];
  for (const m of text.matchAll(ENVELOPE_RE)) {
    out.push({ iface: m[1], channel: m[2] ?? "", userId: m[3] });
  }
  return out;
}

const channelId = (e: Envelope) => `${e.iface}|${e.channel}`;

/**
 * Which recall hits the current turn may see, or null for no restriction.
 *
 * Shared mode: everything, as before. Per-user mode:
 * - core session: only core sessions, never a user's private sessions
 * - user session: its own sessions, plus core-session ranges whose messages
 *   all come from channels the user has posted in. Ranges with no envelope
 *   (can't tell where they came from) are hidden. A user who never posted in
 *   a channel can't recall it, even if they are a silent member.
 */
export async function recallAccess(
  source: EnvelopeSource,
  scope: SessionScope,
  config: Pick<KernConfig, "sessionMode" | "userAliases">,
): Promise<((r: RecallRange) => boolean) | null> {
  if (config.sessionMode !== "per-user") return null;
  const owners = await sessionOwners(source.agentDir);
  // Sessions without a file (e.g. imported) predate owners: treat as core.
  const ownerOf = (id: string) => owners.get(id) ?? "core";
  if (scope.kind === "core") return (r) => ownerOf(r.session_id) === "core";

  const coreIds = [...owners].filter(([, o]) => o === "core").map(([id]) => id);
  const memberOf = new Set<string>();
  for (const { iface, userId } of userIdentities(scope.key, config.userAliases)) {
    for (const e of source.envelopesFromUser(coreIds, userId)) {
      if (e.iface === iface && e.userId === userId) memberOf.add(channelId(e));
    }
  }
  return (r) => {
    const owner = ownerOf(r.session_id);
    if (owner === scope.key) return true;
    if (owner !== "core") return false;
    const envelopes = source.envelopesInRange(r.session_id, r.msg_start, r.msg_end);
    return envelopes.length > 0 && envelopes.every((e) => memberOf.has(channelId(e)));
  };
}
