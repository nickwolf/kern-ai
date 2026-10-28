import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { configDefaults, type KernConfig } from "../src/config.js";
import { canUserWrite, guardMemoryTools, isProtectedPath, restrictKernTool, sessionOwners, sessionInstructions, userDirName } from "../src/user-memory.js";
import { recallAccess, parseEnvelopes, type Envelope } from "../src/plugins/recall/access.js";
import { userIdentities } from "../src/session-router.js";
import { SessionManager } from "../src/session.js";
import { loadSystemPrompt } from "../src/context.js";
import { CORE_SCOPE, type SessionScope } from "../src/turn-context.js";
import { writeProposal, listPending } from "../src/plugins/global-memory/inbox.js";
import { globalMemoryPlugin, proposeGlobalTool } from "../src/plugins/global-memory/plugin.js";
import type { PluginContext } from "../src/plugins/types.js";

const perUser: KernConfig = { ...configDefaults, sessionMode: "per-user" };
const user = (key: string): SessionScope => ({ kind: "user", key });

async function withAgentDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "kern-user-memory-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("userDirName makes keys safe on every filesystem", () => {
  assert.equal(userDirName("slack:U123"), "slack_U123");
  assert.equal(userDirName("matrix:@nick:example.org"), "matrix__nick_example.org");
  assert.equal(userDirName("../etc"), ".._etc");
});

test("canUserWrite: only the user's own memory inside the agent dir", () => {
  const agent = "/agents/a";
  assert.equal(canUserWrite(agent, "slack:U1", "users/slack_U1/notes/2026-10-28.md"), true);
  assert.equal(canUserWrite(agent, "slack:U1", "/agents/a/users/slack_U1/KNOWLEDGE.md"), true);
  assert.equal(canUserWrite(agent, "slack:U1", "users/slack_U2/KNOWLEDGE.md"), false);
  assert.equal(canUserWrite(agent, "slack:U1", "KNOWLEDGE.md"), false);
  assert.equal(canUserWrite(agent, "slack:U1", "knowledge/net.md"), false);
  assert.equal(canUserWrite(agent, "slack:U1", ".kern/config.json"), false);
  assert.equal(canUserWrite(agent, "slack:U1", "users/slack_U1/../../KNOWLEDGE.md"), false);
  // Outside the agent dir is ordinary work, not memory.
  assert.equal(canUserWrite(agent, "slack:U1", "/tmp/report.txt"), true);
});

test("isProtectedPath: personal memory and runtime state", () => {
  const agent = "/agents/a";
  assert.equal(isProtectedPath(agent, CORE_SCOPE, "users/slack_U1/KNOWLEDGE.md"), true);
  assert.equal(isProtectedPath(agent, CORE_SCOPE, "knowledge/net.md"), false);
  assert.equal(isProtectedPath(agent, CORE_SCOPE, "users"), false);
  assert.equal(isProtectedPath(agent, user("slack:U1"), "users/slack_U1/notes/x.md"), false);
  assert.equal(isProtectedPath(agent, user("slack:U1"), "/agents/a/users/slack_U2/KNOWLEDGE.md"), true);
  // .kern/ holds every session's transcripts, recall index and logs.
  for (const p of [".kern/sessions/abc.jsonl", ".kern/recall.db", ".kern/logs/kern.log", ".kern/subagents/sa_1/session.jsonl"]) {
    assert.equal(isProtectedPath(agent, CORE_SCOPE, p), true, p);
    assert.equal(isProtectedPath(agent, user("slack:U1"), p), true, p);
  }
  // Only the core reviews the inbox.
  assert.equal(isProtectedPath(agent, CORE_SCOPE, ".kern/global-inbox/x.md"), false);
  assert.equal(isProtectedPath(agent, user("slack:U1"), ".kern/global-inbox/x.md"), true);
});

test("guardMemoryTools: media tools and .kern searches are guarded", async () => {
  const agent = "/agents/a";
  const pdf = { execute: async (args: { file: string }) => `pdf ${args.file}` };
  const grep = { execute: async () => "./KNOWLEDGE.md:1:x\n./.kern/sessions/abc.jsonl:3:x" };
  const tools = guardMemoryTools({ pdf, grep }, agent, user("slack:U1"));
  assert.match(await tools.pdf.execute({ file: "users/slack_U2/report.pdf" }, {}), /not accessible/);
  assert.equal(await tools.pdf.execute({ file: "users/slack_U1/report.pdf" }, {}), "pdf users/slack_U1/report.pdf");
  assert.equal(await tools.grep.execute({ pattern: "x" }, {}), "./KNOWLEDGE.md:1:x");
});

test("restrictKernTool: logs and pair are operator-only", async () => {
  const kern = { execute: async (args: { action: string }) => `ran ${args.action}` };
  const tools = restrictKernTool({ kern });
  assert.equal(await tools.kern.execute({ action: "status" }, {}), "ran status");
  assert.match(await tools.kern.execute({ action: "logs" }, {}), /only available to the operator/);
  assert.match(await tools.kern.execute({ action: "pair" }, {}), /only available to the operator/);
});

test("guardMemoryTools: user session writes only its own memory", async () => {
  const calls: string[] = [];
  const write = { description: "w", execute: async (args: { path: string }) => { calls.push(args.path); return "ok"; } };
  const tools = guardMemoryTools({ write }, "/agents/a", user("slack:U1"));
  assert.match(await tools.write.execute({ path: "KNOWLEDGE.md" }, {}), /global memory/);
  assert.match(await tools.write.execute({ path: "users/slack_U2/KNOWLEDGE.md" }, {}), /not accessible/);
  assert.equal(await tools.write.execute({ path: "users/slack_U1/KNOWLEDGE.md" }, {}), "ok");
  assert.deepEqual(calls, ["users/slack_U1/KNOWLEDGE.md"]);
});

test("guardMemoryTools: reads and searches hide other users' memory", async () => {
  const agent = "/agents/a";
  const read = { execute: async (args: { path: string }) => `content of ${args.path}` };
  const glob = { execute: async () => [`${agent}/knowledge/net.md`, `${agent}/users/slack_U1/KNOWLEDGE.md`, `${agent}/users/slack_U2/KNOWLEDGE.md`].join("\n") };
  const grep = { execute: async () => ["./KNOWLEDGE.md:1:green", "\x1b[35m./users/slack_U2/KNOWLEDGE.md\x1b[0m:1:green"].join("\n") };

  const core = guardMemoryTools({ read, glob, grep }, agent, CORE_SCOPE);
  assert.match(await core.read.execute({ path: "users/slack_U1/KNOWLEDGE.md" }, {}), /not accessible/);
  assert.equal(await core.read.execute({ path: "KNOWLEDGE.md" }, {}), "content of KNOWLEDGE.md");
  assert.equal(await core.glob.execute({ pattern: "**/*.md" }, {}), `${agent}/knowledge/net.md`);
  assert.equal(await core.grep.execute({ pattern: "green" }, {}), "./KNOWLEDGE.md:1:green");
  assert.match(await core.grep.execute({ pattern: "green", path: "users/slack_U1" }, {}), /not accessible/);

  const u1 = guardMemoryTools({ read, glob }, agent, user("slack:U1"));
  assert.equal(await u1.read.execute({ path: "users/slack_U1/KNOWLEDGE.md" }, {}), "content of users/slack_U1/KNOWLEDGE.md");
  assert.equal(await u1.glob.execute({ pattern: "**/*.md" }, {}), `${agent}/knowledge/net.md\n${agent}/users/slack_U1/KNOWLEDGE.md`);
});

test("sessionInstructions: nothing in shared mode", () => {
  assert.equal(sessionInstructions(configDefaults, CORE_SCOPE), null);
  assert.match(sessionInstructions(perUser, CORE_SCOPE)!, /core session/);
  assert.match(sessionInstructions(perUser, user("slack:U1"))!, /users\/slack_U1/);
});

test("parseEnvelopes reads interface, channel and user", () => {
  const text = "[via slack, #general, user: U1, time: 2026-10-28T08:00:00-06:00]\nhello\n[via tui, user: tui, time: 2026-10-28T08:00:00Z]\nhi";
  assert.deepEqual(parseEnvelopes(text), [
    { iface: "slack", channel: "#general", userId: "U1" },
    { iface: "tui", channel: "", userId: "tui" },
  ]);
});

test("userIdentities reverses aliases", () => {
  assert.deepEqual(userIdentities("slack:U1"), [{ iface: "slack", userId: "U1" }]);
  assert.deepEqual(userIdentities("nick", { "slack:U1": "nick", "telegram:42": "nick" }), [
    { iface: "slack", userId: "U1" }, { iface: "telegram", userId: "42" },
  ]);
});

test("recallAccess: core never sees user sessions; users see own sessions and their channels", async () => {
  await withAgentDir(async (dir) => {
    const core = new SessionManager(dir);
    await core.init();
    await core.create("core-1");
    await new SessionManager(dir, "slack:U1").create("u1");
    await new SessionManager(dir, "slack:U2").create("u2");
    assert.deepEqual([...(await sessionOwners(dir))].sort(), [["core-1", "core"], ["u1", "slack:U1"], ["u2", "slack:U2"]]);

    // core-1 messages: 0 = U1 in #general, 1 = U2 in #general, 2 = U2 in #private, 3 = operator on tui, 4 = mixed range
    const env = (channel: string, userId: string, iface = "slack"): Envelope => ({ iface, channel, userId });
    const byIndex: Envelope[][] = [
      [env("#general", "U1")], [env("#general", "U2")], [env("#private", "U2")], [env("", "tui", "tui")], [],
    ];
    const source = {
      agentDir: dir,
      envelopesInRange: (_s: string, a: number, b: number) => byIndex.slice(a, b).flat(),
      envelopesFromUser: (_ids: string[], userId: string) => byIndex.flat().filter((e) => e.userId === userId),
    };
    // Chunk ranges are end-exclusive.
    const range = (session_id: string, a: number, b = a + 1) => ({ session_id, msg_start: a, msg_end: b });
    const perUser = { sessionMode: "per-user" as const, userAliases: {} };

    assert.equal(await recallAccess(source, CORE_SCOPE, { sessionMode: "shared", userAliases: {} }), null);

    const coreCan = (await recallAccess(source, CORE_SCOPE, perUser))!;
    assert.equal(coreCan(range("core-1", 0)), true);
    assert.equal(coreCan(range("u1", 0)), false);

    const u1 = (await recallAccess(source, user("slack:U1"), perUser))!;
    assert.equal(u1(range("u1", 0)), true);
    assert.equal(u1(range("u2", 0)), false);
    assert.equal(u1(range("core-1", 1)), true, "a channel U1 posted in, even a message by U2");
    assert.equal(u1(range("core-1", 2)), false, "a channel U1 never posted in");
    assert.equal(u1(range("core-1", 3)), false, "the operator's TUI conversation");
    assert.equal(u1(range("core-1", 0, 2)), true, "a range ending just before a foreign channel");
    assert.equal(u1(range("core-1", 1, 3)), false, "a range touching any foreign channel");
    assert.equal(u1(range("core-1", 4)), false, "no envelope, origin unknown");
  });
});

test("loadSystemPrompt: per-user scope adds the session block and personal index", async () => {
  await withAgentDir(async (dir) => {
    await mkdir(join(dir, "users", "slack_U1"), { recursive: true });
    await writeFile(join(dir, "users", "slack_U1", "KNOWLEDGE.md"), "likes green");
    await writeFile(join(dir, "KNOWLEDGE.md"), "global index");

    const shared = await loadSystemPrompt(dir, configDefaults);
    assert.doesNotMatch(shared, /<session>/);
    assert.doesNotMatch(shared, /likes green/);

    const core = await loadSystemPrompt(dir, perUser, {}, CORE_SCOPE);
    assert.match(core, /<session>/);
    assert.doesNotMatch(core, /likes green/);

    const personal = await loadSystemPrompt(dir, perUser, {}, user("slack:U1"));
    assert.match(personal, /global index/);
    assert.match(personal, /<document path="users\/slack_U1\/KNOWLEDGE.md">\nlikes green/);
    const other = await loadSystemPrompt(dir, perUser, {}, user("slack:U2"));
    assert.doesNotMatch(other, /likes green/);
  });
});

test("global inbox: proposals are written and listed oldest first", async () => {
  await withAgentDir(async (dir) => {
    await writeProposal(dir, { from: "slack:U2", sessionId: "u2", target: "knowledge/b.md", change: "B", rationale: "r" }, new Date("2026-10-28T10:00:01Z"));
    await writeProposal(dir, { from: "slack:U1", sessionId: "u1", target: "knowledge/a.md", change: "A", rationale: "r" }, new Date("2026-10-28T10:00:00Z"));
    await mkdir(join(dir, ".kern", "global-inbox", "processed"), { recursive: true });
    const pending = await listPending(dir);
    assert.deepEqual(pending.map((p) => [p.from, p.target]), [["slack:U1", "knowledge/a.md"], ["slack:U2", "knowledge/b.md"]]);
  });
});

test("global-memory plugin: only enabled in per-user mode, inbox shown to core only", async () => {
  await withAgentDir(async (dir) => {
    const announced: string[] = [];
    const ctx = {
      agentDir: dir,
      config: { ...perUser, globalReviewOnPropose: true },
      sessionId: () => "u1",
      scope: () => inTurnScope,
      origin: () => null,
      announce: async (text: string) => { announced.push(text); return "NO_REPLY"; },
    } as unknown as PluginContext;
    let inTurnScope: SessionScope = user("slack:U1");

    assert.equal(globalMemoryPlugin.enabled!({ ...ctx, config: configDefaults } as PluginContext), false);
    assert.equal(globalMemoryPlugin.enabled!(ctx), true);
    await globalMemoryPlugin.onStartup!(ctx);

    const reply = await proposeGlobalTool.execute!({ target: "knowledge/wifi.md", change: "Wifi password is X", rationale: "IT said so" }, { toolCallId: "t", messages: [] });
    assert.match(String(reply), /Proposed/);
    assert.equal(announced.length, 1);

    const info = { trimmedCount: 0, tokenBudget: 0, userQuery: "", sessionId: "u1" };
    assert.equal(await globalMemoryPlugin.onBeforeContext!(info, ctx), null);
    inTurnScope = CORE_SCOPE;
    const injection = await globalMemoryPlugin.onBeforeContext!(info, ctx) as { label: string; content: string };
    assert.equal(injection.label, "global-inbox");
    assert.match(injection.content, /1 pending proposal.*\n.*from slack:U1, target knowledge\/wifi.md/);

    // The core session edits global memory directly.
    assert.match(String(await proposeGlobalTool.execute!({ target: "x", change: "y", rationale: "z" }, { toolCallId: "t", messages: [] })), /core session/);
    await globalMemoryPlugin.onShutdown!(ctx);
  });
});

test("turnToolScope: only the operator keeps the shell in per-user mode", async () => {
  const { turnToolScope } = await import("../src/config.js");
  const full = { ...perUser, toolScope: "full" as const };
  assert.equal(turnToolScope({ ...configDefaults, toolScope: "full" }, user("slack:U1"), "slack"), "full", "shared mode unchanged");
  assert.equal(turnToolScope(full, CORE_SCOPE, "web"), "full");
  assert.equal(turnToolScope(full, CORE_SCOPE, "tui"), "full");
  assert.equal(turnToolScope(full, CORE_SCOPE, "slack"), "write", "group channel");
  assert.equal(turnToolScope(full, CORE_SCOPE, "system"), "write", "heartbeat / review");
  assert.equal(turnToolScope(full, user("slack:U1"), "slack"), "write");
  assert.equal(turnToolScope({ ...full, userToolScope: "full", groupToolScope: "read" }, user("slack:U1"), "slack"), "full");
  assert.equal(turnToolScope({ ...full, groupToolScope: "read" }, CORE_SCOPE, "slack"), "read");
  assert.equal(turnToolScope({ ...perUser, toolScope: "read" }, user("slack:U1"), "slack"), "read");
});

test("global-memory: group turns don't see the inbox; resolve_proposal archives and commits", async () => {
  const { execFileSync } = await import("child_process");
  const { readFile: read, readdir } = await import("fs/promises");
  const { resolveProposalTool, commitMemoryTool } = await import("../src/plugins/global-memory/plugin.js");
  await withAgentDir(async (dir) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeFile(join(dir, "KNOWLEDGE.md"), "index\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    let scope: SessionScope = CORE_SCOPE;
    let iface = "slack";
    const ctx = {
      agentDir: dir, config: perUser, sessionId: () => "s",
      scope: () => scope, origin: () => ({ interface: iface, channel: "#general", userId: "U9" }),
      announce: async () => "NO_REPLY",
    } as unknown as PluginContext;
    await globalMemoryPlugin.onStartup!(ctx);
    await writeProposal(dir, { from: "slack:U1", sessionId: "u1", target: "knowledge/a.md", change: "A", rationale: "r" });
    const [pending] = await listPending(dir);
    const info = { trimmedCount: 0, tokenBudget: 0, userQuery: "", sessionId: "s" };
    const opts = { toolCallId: "t", messages: [] };

    // A group channel turn neither sees nor settles proposals.
    assert.equal(await globalMemoryPlugin.onBeforeContext!(info, ctx), null);
    assert.match(String(await resolveProposalTool.execute!({ file: pending.file, decision: "applied", note: "n" }, opts)), /Only the core/);

    // An automatic turn does both; personal memory is never staged by the core.
    iface = "system";
    assert.ok(await globalMemoryPlugin.onBeforeContext!(info, ctx));
    await mkdir(join(dir, "knowledge"), { recursive: true });
    await writeFile(join(dir, "knowledge", "a.md"), "A\n");
    await mkdir(join(dir, "users", "slack_U1"), { recursive: true });
    await writeFile(join(dir, "users", "slack_U1", "KNOWLEDGE.md"), "private\n");
    assert.match(String(await resolveProposalTool.execute!({ file: "../../KNOWLEDGE.md", decision: "applied", note: "n" }, opts)), /No pending proposal/);
    const out = String(await resolveProposalTool.execute!({ file: pending.file, decision: "applied", note: "added a.md" }, opts));
    assert.match(out, /archived\. Committed \d+ file\(s\); no origin remote/);
    assert.deepEqual(await listPending(dir), []);
    assert.match(await read(join(dir, ".kern", "global-inbox", "processed", pending.file), "utf-8"), /## Decision\n\napplied .*: added a.md/);
    const committed = git("show", "--name-only", "--format=%s", "HEAD");
    assert.match(committed, /global memory: applied proposal from slack:U1/);
    assert.match(committed, /knowledge\/a.md/);
    assert.doesNotMatch(committed, /users\//);

    // A user session commits only its own folder.
    scope = user("slack:U1");
    assert.match(String(await commitMemoryTool.execute!({ message: "personal" }, opts)), /Committed 1 file/);
    assert.equal(git("show", "--name-only", "--format=", "HEAD").trim(), "users/slack_U1/KNOWLEDGE.md");
    assert.equal(String(await commitMemoryTool.execute!({ message: "again" }, opts)), "Nothing to commit.");
    assert.deepEqual(await readdir(join(dir, ".kern", "global-inbox")), ["processed"]);
    await globalMemoryPlugin.onShutdown!(ctx);
  });
});
