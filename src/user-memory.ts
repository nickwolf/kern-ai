import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import type { KernConfig } from "./config.js";
import { readSessionOwner } from "./session.js";
import type { SessionScope } from "./turn-context.js";
import { stripAnsi } from "./util.js";

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
 * Whether `target` lies in personal memory the scope may not see: any user's
 * folder for the core session, any other user's folder for a user session.
 */
export function isForeignPersonalMemory(agentDir: string, scope: SessionScope, target: string): boolean {
  const abs = resolve(agentDir, target);
  const usersRoot = resolve(agentDir, "users");
  // A path above users/ (e.g. the agent dir itself) is not personal memory;
  // searches rooted there are filtered by guardMemoryTools instead.
  if (!isInside(usersRoot, abs) || abs === usersRoot) return false;
  return scope.kind === "core" || !isInside(resolve(userMemoryDir(agentDir, scope.key)), abs);
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

/** Path at the start of a grep/glob output line ("path:line:text" or a bare path). */
function outputPath(line: string): string {
  const plain = stripAnsi(line);
  const m = plain.match(/^(.*?):\d+:/);
  return m ? m[1] : plain;
}

/**
 * Wrap file tools so each session only sees personal memory it owns:
 * - read/write/edit refuse paths in other users' folders (all users' folders
 *   for the core session), and a user session writes nothing else inside the
 *   agent dir; global memory is the core's
 * - glob/grep drop result lines from those folders, since a search rooted at
 *   the agent dir walks into users/
 * `bash` is not guarded; use userToolScope to take it away from user sessions.
 */
export function guardMemoryTools(tools: Record<string, any>, agentDir: string, scope: SessionScope): Record<string, any> {
  const guarded = { ...tools };
  const wrap = (name: string, fn: (original: any) => (args: any, options: unknown) => Promise<unknown>) => {
    if (tools[name]?.execute) guarded[name] = { ...tools[name], execute: fn(tools[name]) };
  };
  const foreign = (p: string) => isForeignPersonalMemory(agentDir, scope, p);
  const refuse = (p: string) => scope.kind === "core"
    ? `Error: ${p} is a user's personal memory. Only that user's own session can access it.`
    : `Error: ${p} is another user's personal memory and is not accessible from this session.`;

  wrap("read", (t) => async (args, options) => foreign(args.path) ? refuse(args.path) : t.execute(args, options));
  for (const name of ["write", "edit"]) {
    wrap(name, (t) => async (args, options) => {
      if (foreign(args.path)) return refuse(args.path);
      if (scope.kind === "user" && !canUserWrite(agentDir, scope.key, args.path)) {
        return `Error: ${args.path} is global memory, which only the core session edits. ` +
          `Write personal memory under ${userMemoryRelPath(scope.key)}/, or use propose_global to suggest a global change.`;
      }
      return t.execute(args, options);
    });
  }
  for (const name of ["glob", "grep"]) {
    wrap(name, (t) => async (args, options) => {
      if (args.path && foreign(args.path)) return refuse(args.path);
      const out = await t.execute(args, options);
      if (typeof out !== "string") return out;
      // glob prints absolute paths; grep prints them relative to the working
      // directory, which is the agent dir.
      const kept = out.split("\n").filter((line) => !line || !foreign(outputPath(line)));
      return kept.some(Boolean) ? kept.join("\n") : (name === "glob" ? "No files matched the pattern." : "No matches found.");
    });
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
      "Personal memory under users/<user>/ and users' private sessions are not readable from here: they belong to each user's own session.",
    ].join("\n");
  }
  const dir = userMemoryRelPath(scope.key);
  return [
    `This session is private to one user (${scope.key}). Other users talk to you in their own sessions.`,
    `Your personal memory for this user is ${dir}/: ${dir}/KNOWLEDGE.md (index), ${dir}/knowledge/ (state), ${dir}/notes/YYYY-MM-DD.md (daily notes).`,
    "Write what you learn about this user and your work with them there.",
    "Global memory (KNOWLEDGE.md, knowledge/, notes/ and the other root files) is read-only here. It is shared by everyone and kept by the core session, and it may change between your turns.",
    "When you learn something everyone should know, call propose_global. Never propose this user's private details.",
    "Recall covers this user's own conversations and the shared channels they take part in.",
  ].join("\n");
}

// Session owners never change, so a lookup is cached for the process lifetime.
const ownerCache = new Map<string, string>();

/** Owner ("core" or a user key) of every session file on disk. */
export async function sessionOwners(agentDir: string): Promise<Map<string, string>> {
  const dir = join(agentDir, ".kern", "sessions");
  const owners = new Map<string, string>();
  if (!existsSync(dir)) return owners;
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".jsonl") || f.endsWith(".media.jsonl")) continue;
    const id = f.slice(0, -".jsonl".length);
    let owner = ownerCache.get(id);
    if (owner === undefined) {
      owner = await readSessionOwner(join(dir, f));
      ownerCache.set(id, owner);
    }
    owners.set(id, owner);
  }
  return owners;
}
