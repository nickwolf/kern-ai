import { MessageQueue } from "./queue.js";
import type { Runtime } from "./runtime.js";
import type { KernConfig } from "./config.js";
import { CORE_SCOPE, type SessionScope } from "./turn-context.js";
import { log } from "./log.js";

export const CORE_KEY = "core";

/** A session together with the queue that serializes its turns. */
export interface Route {
  key: string;
  scope: SessionScope;
  runtime: Runtime;
  queue: MessageQueue;
  lastActive: number;
}

/** What routing needs to know about an incoming message. */
export interface RoutableMessage {
  interface: string;
  userId: string;
  isDirect?: boolean;
  isHeartbeat?: boolean;
}

export function isPerUserMode(config: Pick<KernConfig, "sessionMode">): boolean {
  return config.sessionMode === "per-user";
}

/**
 * Stable key for a user across restarts: `<interface>:<userId>`, unless
 * `userAliases` maps it to a shared name (one person on several platforms).
 */
export function userKey(iface: string, userId: string, aliases: Record<string, string> = {}): string {
  const raw = `${iface}:${userId}`;
  return aliases[raw] || raw;
}

/**
 * Which session a message belongs to. Only direct messages from a real user
 * get their own session, and only in per-user mode. Group channels, heartbeats
 * and system turns stay on the core session.
 */
export function routeKey(msg: RoutableMessage, config: Pick<KernConfig, "sessionMode" | "userAliases">): string {
  if (!isPerUserMode(config) || !msg.isDirect || msg.isHeartbeat) return CORE_KEY;
  if (!msg.userId || msg.interface === "system") return CORE_KEY;
  return userKey(msg.interface, msg.userId, config.userAliases);
}

/** Caps how many sessions run a model turn at the same time. */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, or release it.
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  getActive(): number {
    return this.active;
  }
}

export interface SessionRouterOptions {
  config: KernConfig;
  core: Runtime;
  /** Build and init a Runtime for a user session (hooks wired by the caller). */
  createRuntime: (scope: SessionScope) => Promise<Runtime>;
  /** Install the queue handler and timeout narrator for a new route. */
  attachQueue: (route: Route) => void;
}

/**
 * Owns one Route per live session. In shared mode there is only the core
 * route, so behavior is the same as a single queue. In per-user mode user
 * routes are created on first message and dropped after sitting idle; their
 * session file stays on disk and is resumed on the next message.
 */
export class SessionRouter {
  private routes = new Map<string, Route>();
  private pending = new Map<string, Promise<Route>>();
  private semaphore: Semaphore;
  private evictTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionRouterOptions) {
    const core: Route = {
      key: CORE_KEY,
      scope: CORE_SCOPE,
      runtime: opts.core,
      queue: new MessageQueue(),
      lastActive: Date.now(),
    };
    this.routes.set(CORE_KEY, core);
    opts.attachQueue(core);
    this.semaphore = new Semaphore(Math.max(1, opts.config.maxConcurrentSessions));
  }

  get core(): Route {
    return this.routes.get(CORE_KEY)!;
  }

  /** The route for a message, creating the user session if needed. */
  async route(msg: RoutableMessage): Promise<Route> {
    return this.get(routeKey(msg, this.opts.config));
  }

  /** The route for a key, creating the user session if needed. */
  async get(key: string): Promise<Route> {
    const existing = this.routes.get(key);
    if (existing) {
      existing.lastActive = Date.now();
      return existing;
    }
    // Two messages from a new user can arrive together. Build the route once.
    let building = this.pending.get(key);
    if (!building) {
      building = this.create(key).finally(() => this.pending.delete(key));
      this.pending.set(key, building);
    }
    return building;
  }

  /** The route for a key if it is loaded. Never creates one. */
  peek(key: string): Route | undefined {
    return this.routes.get(key);
  }

  all(): Route[] {
    return [...this.routes.values()];
  }

  /** Run a model turn inside the global concurrency cap. */
  runTurn<T>(fn: () => Promise<T>): Promise<T> {
    return this.semaphore.run(fn);
  }

  /** Aggregate queue status across every live session. */
  getStatus(): { processing: boolean; pending: number; activeChannel: string | null; sessions: number; running: number } {
    let processing = false;
    let pending = 0;
    for (const route of this.routes.values()) {
      const s = route.queue.getStatus();
      processing ||= s.processing;
      pending += s.pending;
    }
    return {
      processing,
      pending,
      activeChannel: this.core.queue.getActiveChannel(),
      sessions: this.routes.size,
      running: this.semaphore.getActive(),
    };
  }

  /** Drop user routes idle longer than `userSessionIdleMinutes`. */
  evictIdle(now = Date.now()): string[] {
    const idleMs = this.opts.config.userSessionIdleMinutes * 60 * 1000;
    const evicted: string[] = [];
    if (idleMs <= 0) return evicted;
    for (const [key, route] of this.routes) {
      if (key === CORE_KEY) continue;
      const status = route.queue.getStatus();
      if (status.processing || status.pending > 0) continue;
      if (now - route.lastActive < idleMs) continue;
      this.routes.delete(key);
      evicted.push(key);
      log("router", `unloaded idle session ${key}`);
    }
    return evicted;
  }

  startEviction(intervalMs = 60_000) {
    if (this.evictTimer || !isPerUserMode(this.opts.config)) return;
    this.evictTimer = setInterval(() => this.evictIdle(), intervalMs);
    this.evictTimer.unref();
  }

  stop() {
    if (this.evictTimer) clearInterval(this.evictTimer);
    this.evictTimer = null;
  }

  private async create(key: string): Promise<Route> {
    const scope: SessionScope = { kind: "user", key };
    const runtime = await this.opts.createRuntime(scope);
    const route: Route = { key, scope, runtime, queue: new MessageQueue(), lastActive: Date.now() };
    this.opts.attachQueue(route);
    this.routes.set(key, route);
    log("router", `loaded session ${key} (${runtime.getSessionId()?.slice(0, 8)})`);
    return route;
  }
}
