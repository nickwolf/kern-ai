import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import type { KernConfig } from "./config.js";
import { readSessionOwner } from "./session.js";
import type { SessionScope } from "./turn-context.js";

/**
 * Per-user memory layout (per-user session mode only):
 *
 *   users/<dir>/KNOWLEDGE.md, users/<dir>/knowledge/, users/<dir>/notes/
 *
 * Global memory (AGENTS.md, KNOWLEDGE.md, knowledge/, notes/, ...) is written
 * only by the core session. User sessions propose global changes to
 * .kern/global-inbox/ and the core session reviews and merges them.
 */

/** Filesystem-safe directory name for a user key (keys contain ":" etc.). */
export function userDirName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Agent-relative path of a user's memory directory, with forward slashes. */
export function userMemoryRelPath(key: string): string {
  return `users/${userDirName(key)}`;
}

export function userMemoryDir(agentDir: string, key: string): string {
  return join(agentDir, "users", userDirName(key));
}

export function globalInboxDir(agentDir: string): string {
  return join(agentDir, ".kern", "global-inbox");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Whether a user session may write `target`. Inside the agent directory only
 * the user's own memory directory is writable; everything else there is
 * global memory or runtime state. Paths outside the agent dir are allowed.
 */
export function canUserWrite(agentDir: string, key: string, target: string): boolean {
  const abs = resolve(agentDir, target);
  if (!isInside(resolve(agentDir), abs)) return true;
  return isInside(resolve(userMemoryDir(agentDir, key)), abs);
}

const GUARDED_TOOLS = ["write", "edit"];

/**
 * Wrap file-writing tools so a user session can't edit global memory. `bash`
 * is not guarded; use userToolScope to take it away from user sessions.
 */
export function guardUserTools(tools: Record<string, any>, agentDir: string, key: string): Record<string, any> {
  const guarded = { ...tools };
  for (const name of GUARDED_TOOLS) {
    const original = tools[name];
    if (!original?.execute) continue;
    guarded[name] = {
      ...original,
      execute: async (args: { path: string }, options: unknown) => {
        if (!canUserWrite(agentDir, key, args.path)) {
          return `Error: ${args.path} is global memory, which only the core session edits. ` +
            `Write personal memory under ${userMemoryRelPath(key)}/, or use propose_global to suggest a global change.`;
        }
        return original.execute(args, options);
      },
    };
  }
  return guarded;
}

/** Instructions telling the model which memory it owns in this session. */
export function sessionInstructions(config: Pick<KernConfig, "sessionMode">, scope: SessionScope): string | null {
  if (config.sessionMode !== "per-user") return null;
  if (scope.kind === "core") {
    return [
      "You are the core session. Each user's direct messages run in their own session, in parallel with this one.",
      "You are the only writer of global memory (KNOWLEDGE.md, knowledge/, notes/, USERS.md, AGENTS.md, IDENTITY.md).",
      "User sessions propose global changes into .kern/global-inbox/. When the global inbox has pending proposals:",
      "- Review each one. Apply it to the right global file if it is accurate and useful to everyone; otherwise reject it.",
      "- Never copy one user's private details into global memory.",
      "- Commit your changes, then move the proposal into .kern/global-inbox/processed/ (rejected ones too, with a one-line reason appended).",
      "Personal memory lives under users/<user>/. Leave it to its user's session.",
    ].join("\n");
  }
  const dir = userMemoryRelPath(scope.key);
  return [
    `This session is private to one user (${scope.key}). Other users talk to you in their own sessions.`,
    `Your personal memory for this user is ${dir}/: ${dir}/KNOWLEDGE.md (index), ${dir}/knowledge/ (state), ${dir}/notes/YYYY-MM-DD.md (daily notes).`,
    "Write what you learn about this user and your work with them there.",
    "Global memory (KNOWLEDGE.md, knowledge/, notes/ and the other root files) is read-only here. It is shared by everyone and kept by the core session, and it may change between your turns.",
    "When you learn something everyone should know, call propose_global. Never propose this user's private details.",
  ].join("\n");
}

// Session owners never change, so a lookup is cached for the process lifetime.
const ownerCache = new Map<string, string>();

/** Session ids a scope may read through recall: its own and the core's. Null = everything. */
export async function readableSessionIds(agentDir: string, scope: SessionScope): Promise<Set<string> | null> {
  if (scope.kind === "core") return null;
  const dir = join(agentDir, ".kern", "sessions");
  const allowed = new Set<string>();
  if (!existsSync(dir)) return allowed;
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".jsonl") || f.endsWith(".media.jsonl")) continue;
    const id = f.slice(0, -".jsonl".length);
    let owner = ownerCache.get(id);
    if (owner === undefined) {
      owner = await readSessionOwner(join(dir, f));
      ownerCache.set(id, owner);
    }
    if (owner === "core" || owner === scope.key) allowed.add(id);
  }
  return allowed;
}
