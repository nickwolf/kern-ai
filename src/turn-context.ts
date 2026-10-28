import { AsyncLocalStorage } from "async_hooks";
import type { TurnOrigin } from "./plugins/types.js";

/**
 * Which memory a session belongs to. The core session is the agent's own
 * (heartbeats, group channels, web/TUI). User sessions exist only in
 * per-user session mode and are keyed by the user they serve.
 */
export type SessionScope = { kind: "core" } | { kind: "user"; key: string };

export const CORE_SCOPE: SessionScope = { kind: "core" };

/** Owner tag stored in session metadata: "core" or the user key. */
export function scopeOwner(scope: SessionScope): string {
  return scope.kind === "core" ? "core" : scope.key;
}

/**
 * Everything about the turn currently being processed. Async-local so
 * concurrent turns (one per session) never see each other's state, and so a
 * turn abandoned by the idle timeout can't clobber the next one.
 */
export interface TurnContext {
  origin: TurnOrigin;
  sessionId: string | null;
  scope: SessionScope;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();

export function currentTurn(): TurnContext | null {
  return turnContext.getStore() ?? null;
}
