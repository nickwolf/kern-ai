import test from "node:test";
import assert from "node:assert/strict";
import { configDefaults, type KernConfig } from "../src/config.js";
import { SessionRouter, Semaphore, routeKey, userKey, CORE_KEY, type Route } from "../src/session-router.js";
import type { Runtime } from "../src/runtime.js";
import type { SessionScope } from "../src/turn-context.js";

const perUser = (overrides: Partial<KernConfig> = {}): KernConfig =>
  ({ ...configDefaults, sessionMode: "per-user", ...overrides });

function fakeRuntime(scope: SessionScope): Runtime {
  const id = scope.kind === "core" ? "core-session" : `session-${scope.key}`;
  return { scope, getSessionId: () => id, getCurrentTurnSnapshot: () => null } as unknown as Runtime;
}

/**
 * Router whose turns block until released, so tests can observe which turns
 * are running at the same time.
 */
function setup(config: KernConfig) {
  const running = new Set<string>();
  let maxRunning = 0;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const created: string[] = [];
  let router!: SessionRouter;

  const attachQueue = (route: Route) => {
    route.queue.setHandler((msg) => router.runTurn(async () => {
      running.add(msg.text);
      maxRunning = Math.max(maxRunning, running.size);
      started.push(msg.text);
      await new Promise<void>((r) => releases.set(msg.text, r));
      running.delete(msg.text);
      return `${route.key}:${msg.text}`;
    }));
  };
  router = new SessionRouter({
    config,
    core: fakeRuntime({ kind: "core" }),
    createRuntime: async (scope) => {
      if (scope.kind === "user") created.push(scope.key);
      return fakeRuntime(scope);
    },
    attachQueue,
  });

  const send = async (text: string, userId: string, isDirect: boolean) => {
    const route = await router.route({ interface: "slack", userId, isDirect });
    return route.queue.enqueue({ text, userId, interface: "slack", channel: `c-${userId}`, isDirect });
  };
  const waitStarted = async (text: string) => {
    while (!releases.has(text)) await new Promise((r) => setTimeout(r, 1));
  };
  const release = (text: string) => releases.get(text)!();
  return { router, send, started, created, waitStarted, release, running, maxRunning: () => maxRunning };
}

test("routeKey: shared mode always routes to core", () => {
  const msg = { interface: "slack", userId: "U1", isDirect: true };
  assert.equal(routeKey(msg, { ...configDefaults }), CORE_KEY);
});

test("routeKey: per-user mode routes DMs by user, everything else to core", () => {
  const config = perUser();
  assert.equal(routeKey({ interface: "slack", userId: "U1", isDirect: true }, config), "slack:U1");
  assert.equal(routeKey({ interface: "slack", userId: "U1", isDirect: false }, config), CORE_KEY);
  assert.equal(routeKey({ interface: "web", userId: "tui" }, config), CORE_KEY);
  assert.equal(routeKey({ interface: "system", userId: "system", isDirect: true, isHeartbeat: true }, config), CORE_KEY);
});

test("userKey: aliases merge one person's accounts", () => {
  const aliases = { "slack:U1": "nick", "telegram:42": "nick" };
  assert.equal(userKey("slack", "U1", aliases), "nick");
  assert.equal(userKey("telegram", "42", aliases), "nick");
  assert.equal(userKey("slack", "U2", aliases), "slack:U2");
});

test("router: two users' DMs run concurrently", async () => {
  const t = setup(perUser());
  const a = t.send("A", "U1", true);
  const b = t.send("B", "U2", true);
  await t.waitStarted("A");
  await t.waitStarted("B");
  assert.equal(t.maxRunning(), 2);
  t.release("A");
  t.release("B");
  assert.equal(await a, "slack:U1:A");
  assert.equal(await b, "slack:U2:B");
});

test("router: one user's turns stay serialized", async () => {
  const t = setup(perUser());
  const a1 = t.send("A1", "U1", true);
  await t.waitStarted("A1");
  // Same user, different channel label so it isn't folded into the active turn.
  const route = await t.router.route({ interface: "slack", userId: "U1", isDirect: true });
  const a2 = route.queue.enqueue({ text: "A2", userId: "U1", interface: "slack", channel: "other", isDirect: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.started, ["A1"]);
  t.release("A1");
  await a1;
  await t.waitStarted("A2");
  t.release("A2");
  assert.equal(await a2, "slack:U1:A2");
});

test("router: shared mode keeps a single queue", async () => {
  const t = setup({ ...configDefaults });
  const a = t.send("A", "U1", true);
  const b = t.send("B", "U2", true);
  await t.waitStarted("A");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.started, ["A"]);
  t.release("A");
  await t.waitStarted("B");
  t.release("B");
  assert.equal(await a, "core:A");
  assert.equal(await b, "core:B");
  assert.equal(t.router.all().length, 1);
  assert.deepEqual(t.created, []);
});

test("router: maxConcurrentSessions caps running turns", async () => {
  const t = setup(perUser({ maxConcurrentSessions: 2 }));
  const replies = ["A", "B", "C"].map((x, i) => t.send(x, `U${i}`, true));
  await t.waitStarted("A");
  await t.waitStarted("B");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.started, ["A", "B"]);
  t.release("A");
  await t.waitStarted("C");
  t.release("B");
  t.release("C");
  await Promise.all(replies);
  assert.equal(t.maxRunning(), 2);
});

test("router: a new user's first messages build the session once", async () => {
  const t = setup(perUser());
  const [r1, r2] = await Promise.all([
    t.router.route({ interface: "slack", userId: "U1", isDirect: true }),
    t.router.route({ interface: "slack", userId: "U1", isDirect: true }),
  ]);
  assert.equal(r1, r2);
  assert.deepEqual(t.created, ["slack:U1"]);
});

test("router: idle user sessions are unloaded, busy ones and core are kept", async () => {
  const t = setup(perUser({ userSessionIdleMinutes: 1 }));
  await t.router.route({ interface: "slack", userId: "U1", isDirect: true });
  const busy = t.send("B", "U2", true);
  await t.waitStarted("B");

  const later = Date.now() + 2 * 60 * 1000;
  assert.deepEqual(t.router.evictIdle(later), ["slack:U1"]);
  assert.deepEqual(t.router.all().map((r) => r.key).sort(), [CORE_KEY, "slack:U2"]);

  // Coming back reloads it.
  await t.router.route({ interface: "slack", userId: "U1", isDirect: true });
  assert.deepEqual(t.created, ["slack:U1", "slack:U2", "slack:U1"]);
  t.release("B");
  await busy;
});

test("Semaphore: releases slots in order", async () => {
  const sem = new Semaphore(1);
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => sem.run(async () => {
    order.push(n);
    await new Promise((r) => setTimeout(r, 2));
  })));
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(sem.getActive(), 0);
});

test("Semaphore: a waiting normal turn goes before waiting heartbeats", async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];
  let release!: () => void;
  const first = sem.run(() => new Promise<void>((r) => { release = r; }));
  const hb = sem.run(async () => { order.push("heartbeat"); }, { low: true });
  const dm = sem.run(async () => { order.push("dm"); });
  release();
  await Promise.all([first, hb, dm]);
  assert.deepEqual(order, ["dm", "heartbeat"]);
});

test("router: beforeEvict can keep a route one more round; onEvict sees it go", async () => {
  const kept: string[] = [];
  const gone: string[] = [];
  let allow = false;
  const router = new SessionRouter({
    config: perUser({ userSessionIdleMinutes: 1 }),
    core: fakeRuntime({ kind: "core" }),
    createRuntime: async (scope) => fakeRuntime(scope),
    attachQueue: () => {},
    beforeEvict: (r) => { kept.push(r.key); return allow; },
    onEvict: (r) => gone.push(r.key),
  });
  await router.route({ interface: "slack", userId: "U1", isDirect: true });
  const later = Date.now() + 2 * 60 * 1000;
  assert.deepEqual(router.evictIdle(later), []);
  allow = true;
  assert.deepEqual(router.evictIdle(later), ["slack:U1"]);
  assert.deepEqual(kept, ["slack:U1", "slack:U1"]);
  assert.deepEqual(gone, ["slack:U1"]);
});
