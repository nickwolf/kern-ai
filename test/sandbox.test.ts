import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sandboxArgv, sandboxReady } from "../src/sandbox.js";
import { argvExec } from "../src/tools/shell.js";
import { userMemoryRelPath } from "../src/user-memory.js";
import { CORE_SCOPE } from "../src/turn-context.js";
import { turnContext } from "../src/turn-context.js";
import { setTrustConfig, untrustedRequester } from "../src/trust.js";

const cfg = { untrustedShellEnv: [] as string[], untrustedShellHide: [] as string[] };
const alice = { kind: "user" as const, key: "slack:UALICE" };

test("sandbox: hides other users, .kern, .git and secrets; DM writes only its own folder", { skip: !sandboxReady() }, async () => {
  const agent = await mkdtemp(join(tmpdir(), "kern-sandbox-"));
  try {
    const mine = userMemoryRelPath(alice.key), bobs = userMemoryRelPath("slack:UBOB");
    for (const d of [mine, bobs, ".kern", ".git", "knowledge"]) await mkdir(join(agent, d), { recursive: true });
    await writeFile(join(agent, bobs, "K.md"), "bob-secret\n");
    await writeFile(join(agent, mine, "K.md"), "alice-own\n");
    await writeFile(join(agent, ".kern", ".env"), "TOKEN=x\n");
    await writeFile(join(agent, ".git", "config"), "[core]\n");
    await writeFile(join(agent, "knowledge", "a.md"), "fact\n");
    process.env.KERN_AUTH_TOKEN_TEST = "should-not-leak";

    const run = async (scope: any, cmd: string) => {
      const [file, args] = sandboxArgv(agent, scope, cmd, cfg);
      const r = await argvExec(file, args, { timeout: 20_000 });
      return r.stdout + r.stderr;
    };
    const dm = await run(alice, `cat knowledge/a.md ${mine}/K.md; cat ${bobs}/K.md .kern/.env .git/config 2>&1; echo "env=$KERN_AUTH_TOKEN_TEST"; ls /proc | grep -c '^[0-9]'; echo w > ${mine}/new.md; echo w > knowledge/b.md 2>&1`);
    assert.match(dm, /fact\nalice-own/);
    assert.doesNotMatch(dm, /bob-secret|TOKEN=x|\[core\]|should-not-leak/);
    assert.match(dm, /env=\n/);
    assert.equal(existsSync(join(agent, mine, "new.md")), true, "own folder writable");
    assert.equal(existsSync(join(agent, "knowledge", "b.md")), false, "global memory read-only for a DM");

    const core = await run(CORE_SCOPE, `cat ${mine}/K.md 2>&1; echo g > knowledge/c.md; echo x >> AGENTS.md 2>&1; true`);
    assert.doesNotMatch(core, /alice-own/);
    assert.equal(await readFile(join(agent, "knowledge", "c.md"), "utf-8"), "g\n", "core writes global memory");
  } finally {
    delete process.env.KERN_AUTH_TOKEN_TEST;
    await rm(agent, { recursive: true, force: true });
  }
});

test("untrustedRequester: the operator is trusted; others carry their ID on that platform only", () => {
  setTrustConfig({ sessionMode: "per-user", operatorUsers: ["slack:UNICK"], userAliases: {} });
  const turn = (scope: any, iface: string, userId: string) =>
    turnContext.run({ origin: { interface: iface, channel: "c", userId }, sessionId: "s", scope }, () => untrustedRequester("slack"));
  assert.equal(turn(CORE_SCOPE, "tui", "tui"), null);
  assert.equal(turn({ kind: "user", key: "slack:UNICK" }, "slack", "UNICK"), null);
  assert.equal(turn(alice, "slack", "UALICE"), "UALICE");
  assert.equal(turn(CORE_SCOPE, "slack", "UBOB"), "UBOB", "group channel: the poster");
  assert.equal(turn({ kind: "user", key: "matrix:@a:hs" }, "matrix", "@a:hs"), "", "no Slack identity");
  setTrustConfig({ sessionMode: "shared", operatorUsers: [], userAliases: {} });
  assert.equal(turn(alice, "slack", "UALICE"), null, "shared mode");
});

test("sandbox: home hidden, /tmp persists, core can't create git or skill files", { skip: !sandboxReady() }, async () => {
  const agent = await mkdtemp(join(tmpdir(), "kern-sandbox-"));
  const fakeHome = await mkdtemp(join(tmpdir(), "kern-home-"));
  const realHome = process.env.HOME;
  try {
    await mkdir(join(agent, ".kern"), { recursive: true });
    await writeFile(join(agent, "AGENTS.md"), "orig\n");
    await mkdir(join(fakeHome, ".kern", "backups"), { recursive: true });
    await writeFile(join(fakeHome, ".kern", "backups", "all.tgz"), "everyone's memory\n");
    process.env.HOME = fakeHome;
    const run = async (scope: any, cmd: string) => {
      const [file, args] = sandboxArgv(agent, scope, cmd, cfg);
      const r = await argvExec(file, args, { timeout: 20_000 });
      return r.stdout + r.stderr;
    };
    const out = await run(alice, `cat ${fakeHome}/.kern/backups/all.tgz 2>&1; echo "home=$HOME"; echo kept > /tmp/x`);
    assert.doesNotMatch(out, /everyone's memory/);
    assert.match(out, /home=\/tmp\/home/);
    assert.match(await run(alice, "cat /tmp/x"), /kept/, "/tmp persists between commands");
    assert.doesNotMatch(await run(CORE_SCOPE, "cat /tmp/x 2>&1"), /kept/, "each session has its own /tmp");

    await run(CORE_SCOPE, "git init -q . 2>/dev/null; mkdir -p skills/x .agents 2>/dev/null; echo x >> AGENTS.md 2>/dev/null; echo n > notes/n.md; true");
    assert.equal(existsSync(join(agent, ".git")), false, "no repo planted for commit_memory to run");
    assert.equal(existsSync(join(agent, "skills", "x")), false);
    assert.equal(existsSync(join(agent, ".agents")), false);
    assert.equal(await readFile(join(agent, "AGENTS.md"), "utf-8"), "orig\n");
    assert.equal(await readFile(join(agent, "notes", "n.md"), "utf-8"), "n\n", "global memory stays writable");
  } finally {
    process.env.HOME = realHome;
    await rm(agent, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});
