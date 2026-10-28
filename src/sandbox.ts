import { spawnSync } from "child_process";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { join, relative, isAbsolute, resolve } from "path";
import type { KernConfig } from "./config.js";
import type { SessionScope } from "./turn-context.js";
import { userMemoryDir, userDirName } from "./user-memory.js";
import { log } from "./log.js";

/**
 * Sandboxed shell for untrusted turns in per-user mode (bubblewrap, Linux).
 *
 * Every session runs as the agent's OS user, so a plain shell can read any
 * user's memory, every transcript under .kern/, and the secrets in kern's
 * environment. Inside the sandbox those don't exist:
 * - other users' folders (every user's, for the core session), .kern/,
 *   .git/ and the real home directory are hidden; a user's own folder
 *   stays visible
 * - the environment is cleared (no auth token, API keys or bot tokens),
 *   except PATH, locale, TZ and the operator's `untrustedShellEnv`
 * - a separate PID namespace, so /proc doesn't reach kern's process
 * - the agent dir is read-only, except a DM's own folder, or global memory
 *   (knowledge/, notes/, KNOWLEDGE.md, USERS.md) for core turns
 * - /tmp (with HOME at /tmp/home) is a persistent scratch area per session
 * The network and the rest of the filesystem stay as they are.
 */

let ready: boolean | null = null;

/** Whether bubblewrap can create a sandbox here. Probed once. */
export function sandboxReady(): boolean {
  if (ready === null) {
    if (process.platform !== "linux") {
      ready = false;
      log.warn("sandbox", `sandboxed shell needs Linux (this is ${process.platform}); untrusted turns get no shell.`);
    } else {
      const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--", "true"], { timeout: 10_000 });
      ready = probe.status === 0;
      if (!ready) {
        const why = probe.error ? (probe.error as any).code === "ENOENT" ? "bubblewrap (bwrap) is not installed" : probe.error.message : String(probe.stderr || "").trim();
        log.warn("sandbox", `sandboxed shell unavailable, untrusted turns get no shell: ${why}. See docs/sessions.md.`);
      } else {
        log("sandbox", "sandboxed shell ready for untrusted turns");
      }
    }
  }
  return ready;
}

/** Whether untrusted turns get a sandboxed shell under this config. */
export function sandboxedShellEnabled(config: Pick<KernConfig, "sessionMode" | "untrustedShell" | "toolScope">): boolean {
  return config.sessionMode === "per-user" && config.untrustedShell === "sandbox" && config.toolScope === "full" && sandboxReady();
}

const PASS_ENV = ["PATH", "USER", "LANG", "LC_ALL", "TERM", "TZ"];

// What a core turn's shell may change in the agent dir: global memory only.
// Everything else there (AGENTS.md, skills/, .agents/, git files, ...) steers
// the agent or git and stays read-only, whether or not it exists yet.
const CORE_WRITABLE_DIRS = ["knowledge", "notes"];
const CORE_WRITABLE_FILES = ["KNOWLEDGE.md", "USERS.md"];

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** bwrap arguments that run `command` with bash inside the sandbox for `scope`. */
export function sandboxArgv(
  agentDir: string,
  scope: SessionScope,
  command: string,
  config: Pick<KernConfig, "untrustedShellEnv" | "untrustedShellHide">,
): [string, string[]] {
  const root = realpathSync(agentDir);
  // A persistent scratch area per session (shared by the core's turns):
  // /tmp inside the sandbox, with HOME at /tmp/home. Kept under .kern/,
  // which the sandbox itself can't see.
  const scratch = join(root, ".kern", "sandbox", scope.kind === "core" ? "core" : userDirName(scope.key));
  mkdirSync(join(scratch, "home"), { recursive: true });
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
  ];
  // Hide the real home directory: backups (~/.kern/backups hold every
  // user's memory), SSH keys, tool credentials. The agent dir is mounted
  // again below if it lives there.
  const home = process.env.HOME ? resolve(process.env.HOME) : "";
  if (home && home !== "/" && !inside(home, root) && existsSync(home)) args.push("--tmpfs", home);
  args.push("--bind", scratch, "/tmp");
  args.push("--ro-bind", root, root);
  for (const hidden of [join(root, "users"), join(root, ".kern"), join(root, ".git"), ...(config.untrustedShellHide ?? [])]) {
    if (existsSync(hidden)) args.push("--tmpfs", hidden);
  }
  if (scope.kind === "core") {
    for (const name of CORE_WRITABLE_DIRS) {
      mkdirSync(join(root, name), { recursive: true });
      args.push("--bind", join(root, name), join(root, name));
    }
    for (const name of CORE_WRITABLE_FILES) {
      if (existsSync(join(root, name))) args.push("--bind", join(root, name), join(root, name));
    }
  } else {
    const own = userMemoryDir(root, scope.key);
    mkdirSync(own, { recursive: true });
    args.push("--bind", own, own);
  }
  args.push("--clearenv", "--setenv", "HOME", "/tmp/home");
  for (const name of [...PASS_ENV, ...(config.untrustedShellEnv ?? [])]) {
    const value = process.env[name];
    if (value !== undefined && name !== "HOME") args.push("--setenv", name, value);
  }
  args.push("--chdir", root, "--", "bash", "-c", command);
  return ["bwrap", args];
}
