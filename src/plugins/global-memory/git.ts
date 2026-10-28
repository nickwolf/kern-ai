import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, statSync, realpathSync } from "fs";
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
/**
 * The agent repo's .git as it was when kern started. Commits run git outside
 * the sandbox, so they only use a repository the operator set up: a .git
 * created later (by a sandboxed shell, say) could carry a config that runs
 * commands.
 */
let startupGitDir: string | null = null;

function gitDirAtStartup(agentDir: string): string | null {
  const dotGit = join(agentDir, ".git");
  try {
    return statSync(dotGit).isDirectory() ? realpathSync(dotGit) : null;
  } catch {
    return null;
  }
}

function sameGitDirAsStartup(agentDir: string): boolean {
  return startupGitDir !== null && gitDirAtStartup(agentDir) === startupGitDir;
}

export function keepUsersOutOfGit(agentDir: string): Promise<void> {
  startupGitDir = gitDirAtStartup(agentDir);
  return serialized(async () => {
    if (!startupGitDir) return;
    try {
      await git(agentDir, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return;
    }
    const ignorePath = join(agentDir, ".gitignore");
    const current = existsSync(ignorePath) ? await readFile(ignorePath, "utf-8") : "";
    if (!current.split(/\r?\n/).some((l) => l.trim() === "users/" || l.trim() === "/users/")) {
      await appendFile(ignorePath, `${current && !current.endsWith("\n") ? "\n" : ""}# personal memory (per-user sessions), never committed\nusers/\n`);
      log("global-memory", "added users/ to .gitignore");
    }
    const { stdout: tracked } = await git(agentDir, ["ls-files", "--", "users"]);
    if (!tracked.trim()) return;
    const { stdout: staged } = await git(agentDir, ["diff", "--cached", "--name-only"]);
    await git(agentDir, ["rm", "-r", "-q", "--cached", "--", "users"]);
    // Commit the untracking on its own unless other work is staged; then it
    // goes out with the next commit_memory, which commits the whole index.
    if (staged.trim()) {
      log.warn("global-memory", "stopped tracking users/ in git; the change is staged and goes out with the next commit");
      return;
    }
    await git(agentDir, ["commit", "-q", "--no-verify", "-m", "Stop tracking personal memory (users/)"]);
    log.warn("global-memory", "stopped tracking users/ in git; earlier commits still contain it");
  });
}

/**
 * Run git in the agent dir without a shell, prompts, hooks or fsmonitor. The
 * agent repo's own config can't name commands to run here, and untrusted
 * turns can't edit .git/ or .gitattributes (see isProtectedPath).
 */
function git(agentDir: string, args: string[], timeout = 30_000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: agentDir, env, timeout });
}

/**
 * Stage `pathspecs`, then commit the index and push to origin if one exists.
 * Personal memory (users/) and runtime state (.kern/) are never committed,
 * whatever else is staged. Returns a one-line outcome for the model.
 */
export function commitMemory(agentDir: string, pathspecs: string[], message: string): Promise<string> {
  return serialized(async () => {
    if (!sameGitDirAsStartup(agentDir)) {
      return "Nothing committed: the agent directory had no git repository when kern started. The operator can create one and restart.";
    }
    try {
      await git(agentDir, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return "Not a git repository; nothing committed.";
    }
    let staged: string;
    try {
      await git(agentDir, ["add", "-A", "--", ...pathspecs]);
      // Drop personal memory and runtime state from the index. Removals under
      // users/ stay: they untrack files committed before per-user mode.
      const { stdout: personal } = await git(agentDir, ["diff", "--cached", "--name-only", "--diff-filter=AMRCT", "--", "users"]);
      const added = personal.split("\n").filter(Boolean);
      if (added.length) await git(agentDir, ["reset", "-q", "--", ...added]);
      await git(agentDir, ["reset", "-q", "--", ".kern"]).catch(() => {});
      staged = (await git(agentDir, ["diff", "--cached", "--name-only"])).stdout;
      if (!staged.trim()) return "Nothing to commit.";
      // The index, not `-- <paths>`: a path-limited commit takes tracked files
      // from the working tree and would put back what was just unstaged.
      await git(agentDir, ["commit", "-q", "--no-verify", "-m", message]);
    } catch (err: any) {
      throw new Error(String(err.stderr || err.message).trim().split("\n").pop());
    }
    const files = staged.trim().split("\n").length;

    const { stdout: remotes } = await git(agentDir, ["remote"]);
    if (!remotes.split("\n").includes("origin")) return `Committed ${files} file(s); no origin remote to push to.`;
    try {
      await git(agentDir, ["push", "origin", "HEAD"], 60_000);
      return `Committed ${files} file(s) and pushed to origin.`;
    } catch (err: any) {
      return `Committed ${files} file(s); push failed: ${String(err.stderr || err.message).trim().split("\n").pop()}`;
    }
  });
}
