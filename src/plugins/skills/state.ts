import { currentTurn, scopeOwner, CORE_SCOPE } from "../../turn-context.js";

/**
 * In-memory sets of active skill names — reset on restart. Keyed by session
 * owner so one user's skills don't leak into another user's session; outside
 * a turn (HTTP routes, startup) the core set is used.
 */
const activeSkillsByOwner = new Map<string, Set<string>>();

function current(): Set<string> {
  const owner = scopeOwner(currentTurn()?.scope ?? CORE_SCOPE);
  let set = activeSkillsByOwner.get(owner);
  if (!set) {
    set = new Set<string>();
    activeSkillsByOwner.set(owner, set);
  }
  return set;
}

/** Drop an unloaded user session's active skills. */
export function forgetActiveSkills(owner: string) {
  activeSkillsByOwner.delete(owner);
}

export function getActiveSkills(): Set<string> {
  return current();
}

export function isActive(name: string): boolean {
  return current().has(name);
}

/** Activate a skill. Returns true if newly activated, false if already active. */
export function activate(name: string): boolean {
  const active = current();
  if (active.has(name)) return false;
  active.add(name);
  return true;
}

/** Deactivate a skill. Returns true if was active, false if wasn't. */
export function deactivate(name: string): boolean {
  const active = current();
  if (!active.has(name)) return false;
  active.delete(name);
  return true;
}
