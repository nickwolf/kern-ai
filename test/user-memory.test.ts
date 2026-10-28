import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { configDefaults, type KernConfig } from "../src/config.js";
import { canUserWrite, guardUserTools, readableSessionIds, sessionInstructions, userDirName } from "../src/user-memory.js";
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

test("guardUserTools blocks global writes and passes personal ones through", async () => {
  const calls: string[] = [];
  const write = { description: "w", execute: async (args: { path: string }) => { calls.push(args.path); return "ok"; } };
  const read = { description: "r", execute: async () => "content" };
  const tools = guardUserTools({ write, read }, "/agents/a", "slack:U1");
  assert.equal(tools.read, read);
  assert.match(await tools.write.execute({ path: "KNOWLEDGE.md" }, {}), /global memory/);
  assert.equal(await tools.write.execute({ path: "users/slack_U1/KNOWLEDGE.md" }, {}), "ok");
  assert.deepEqual(calls, ["users/slack_U1/KNOWLEDGE.md"]);
});

test("sessionInstructions: nothing in shared mode", () => {
  assert.equal(sessionInstructions(configDefaults, CORE_SCOPE), null);
  assert.match(sessionInstructions(perUser, CORE_SCOPE)!, /core session/);
  assert.match(sessionInstructions(perUser, user("slack:U1"))!, /users\/slack_U1/);
});

test("readableSessionIds: own and core sessions only", async () => {
  await withAgentDir(async (dir) => {
    const core = new SessionManager(dir);
    await core.init();
    await core.create("core-1");
    await new SessionManager(dir, "slack:U1").create("u1");
    await new SessionManager(dir, "slack:U2").create("u2");

    assert.equal(await readableSessionIds(dir, CORE_SCOPE), null);
    assert.deepEqual([...(await readableSessionIds(dir, user("slack:U1")))!].sort(), ["core-1", "u1"]);
    assert.deepEqual([...(await readableSessionIds(dir, user("slack:U2")))!].sort(), ["core-1", "u2"]);
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
