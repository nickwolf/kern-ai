import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, appendFile } from "fs/promises";
import { join } from "path";
import { log } from "../../log.js";

const run = promisify(execFile);

// Sessions run concurrently in per-user mode; git's index lock doesn't
// tolerate parallel commits, so every git operation goes through this chain.
let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * Per-user mode keeps personal memory out of git: anyone who can read the
 * agent repo (or its origin) would otherwise read every user's memory. Adds
 * users/ to .gitignore and stops tracking files committed there before.
 * Past commits still contain them.
 */
export function keepUsersOutOfGit(agentDir: string): Promise<void> {
  return serialized(async () => {
    const git = (args: string[]) => run("git", args, { cwd: agentDir, timeout: 30_000 });
    try {
      await git(["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return;
    }
    const ignorePath = join(agentDir, ".gitignore");
    const current = existsSync(ignorePath) ? await readFile(ignorePath, "utf-8") : "";
    if (!current.split(/\r?\n/).some((l) => l.trim() === "users/" || l.trim() === "/users/")) {
      await appendFile(ignorePath, `${current && !current.endsWith("\n") ? "\n" : ""}# personal memory (per-user sessions), never committed\nusers/\n`);
      log("global-memory", "added users/ to .gitignore");
    }
    const { stdout: tracked } = await git(["ls-files", "--", "users"]);
    if (!tracked.trim()) return;
    // Commit the untracking on its own, but only when nothing else is staged,
    // so it never sweeps up someone's work in progress. A later path-limited
    // commit would otherwise put the files back.
    const { stdout: staged } = await git(["diff", "--cached", "--name-only"]);
    if (staged.trim()) {
      log.warn("global-memory", "users/ is tracked in git, but other changes are staged; run `git rm -r --cached users` and commit");
      return;
    }
    await git(["rm", "-r", "-q", "--cached", "--", "users"]);
    await git(["commit", "-q", "-m", "Stop tracking personal memory (users/)"]);
    log.warn("global-memory", "stopped tracking users/ in git; earlier commits still contain it");
  });
}

/**
 * Stage and commit only `pathspecs`, then push to origin if one exists.
 * Never runs a shell; returns a one-line outcome for the model.
 */
export function commitMemory(agentDir: string, pathspecs: string[], message: string): Promise<string> {
  return serialized(async () => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const git = (args: string[], timeout = 30_000) => run("git", args, { cwd: agentDir, env, timeout });
    try {
      await git(["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return "Not a git repository; nothing committed.";
    }
    let staged: string;
    try {
      await git(["add", "-A", "--", ...pathspecs]);
      // Personal memory never goes into a commit, even if .gitignore lost
      // users/. Removals stay staged: they untrack files committed before.
      const { stdout: personal } = await git(["diff", "--cached", "--name-only", "--diff-filter=AMRC", "--", "users"]);
      const added = personal.split("\n").filter(Boolean);
      if (added.length) await git(["reset", "-q", "--", ...added]);
      staged = (await git(["diff", "--cached", "--name-only", "--", ...pathspecs])).stdout;
      if (!staged.trim()) return "Nothing to commit.";
      await git(["commit", "-m", message, "--", ...pathspecs]);
    } catch (err: any) {
      // Leave nothing staged for a later, unrelated commit to pick up.
      await git(["reset", "-q", "--", ...pathspecs]).catch(() => {});
      throw new Error(String(err.stderr || err.message).trim().split("\n").pop());
    }
    const files = staged.trim().split("\n").length;

    const { stdout: remotes } = await git(["remote"]);
    if (!remotes.split("\n").includes("origin")) return `Committed ${files} file(s); no origin remote to push to.`;
    try {
      await git(["push", "origin", "HEAD"], 60_000);
      return `Committed ${files} file(s) and pushed to origin.`;
    } catch (err: any) {
      return `Committed ${files} file(s); push failed: ${String(err.stderr || err.message).trim().split("\n").pop()}`;
    }
  });
}
