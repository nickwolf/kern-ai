import { execFile } from "child_process";
import { promisify } from "util";

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
    await git(["add", "-A", "--", ...pathspecs]);
    const { stdout: staged } = await git(["diff", "--cached", "--name-only", "--", ...pathspecs]);
    if (!staged.trim()) return "Nothing to commit.";
    await git(["commit", "-m", message, "--", ...pathspecs]);
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
