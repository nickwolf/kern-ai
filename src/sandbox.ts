import { spawnSync } from "child_process";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";
import type { KernConfig } from "./config.js";
import type { SessionScope } from "./turn-context.js";
import { userMemoryDir } from "./user-memory.js";
import { log } from "./log.js";

/**
 * Sandboxed shell for untrusted turns in per-user mode (bubblewrap, Linux).
 *
 * Every session runs as the agent's OS user, so a plain shell can read any
 * user's memory, every transcript under .kern/, and the secrets in kern's
 * environment. Inside the sandbox those don't exist:
 * - other users' folders (every user's, for the core session), .kern/ and
 *   .git/ are empty tmpfs mounts; a user's own folder stays visible
 * - the environment is cleared (no auth token, API keys or bot tokens),
 *   except PATH, HOME, locale, TZ and the operator's `untrustedShellEnv`
 * - a separate PID namespace, so /proc doesn't reach kern's process
 * - a DM session writes only its own folder and /tmp; core turns write the
 *   agent dir except the files that steer the agent
 * The network and the rest of the filesystem stay as they are.
 */

let ready: boolean | null = null;

/** Whether bubblewrap can create a sandbox here. Probed once. */
export function sandboxReady(): boolean {
  if (ready === null) {
    if (process.platform !== "linux") {
      ready = false;
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

// Writes that would let an untrusted turn steer the agent's future turns.
const READ_ONLY = ["AGENTS.md", "IDENTITY.md", "KERN.md", "skills", ".gitignore", ".gitattributes", ".gitmodules"];
const PASS_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TZ"];

/** bwrap arguments that run `command` with bash inside the sandbox for `scope`. */
export function sandboxArgv(
  agentDir: string,
  scope: SessionScope,
  command: string,
  config: Pick<KernConfig, "untrustedShellEnv" | "untrustedShellHide">,
): [string, string[]] {
  const root = realpathSync(agentDir);
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
  ];
  // Mount the agent dir explicitly (after the private /tmp, in case it lives
  // there): writable for core turns, read-only for DM sessions.
  args.push(scope.kind === "core" ? "--bind" : "--ro-bind", root, root);
  if (scope.kind === "core") {
    for (const name of READ_ONLY) {
      const p = join(root, name);
      if (existsSync(p)) args.push("--ro-bind", p, p);
    }
  }
  for (const hidden of [join(root, "users"), join(root, ".kern"), join(root, ".git"), ...(config.untrustedShellHide ?? [])]) {
    if (existsSync(hidden)) args.push("--tmpfs", hidden);
  }
  if (scope.kind === "user") {
    const own = userMemoryDir(root, scope.key);
    mkdirSync(own, { recursive: true });
    args.push("--bind", own, own);
  }
  args.push("--clearenv");
  for (const name of [...PASS_ENV, ...(config.untrustedShellEnv ?? [])]) {
    const value = process.env[name];
    if (value !== undefined) args.push("--setenv", name, value);
  }
  args.push("--chdir", root, "--", "bash", "-c", command);
  return ["bwrap", args];
}
