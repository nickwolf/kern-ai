import { test } from "node:test";
import assert from "node:assert/strict";
import { turnContext, currentTurn, CORE_SCOPE, type TurnContext } from "../src/turn-context.js";
import { activate, isActive, getActiveSkills } from "../src/plugins/skills/state.js";

function ctx(scope: TurnContext["scope"], sessionId: string): TurnContext {
  return { origin: { interface: "slack", channel: "dm", userId: "u" }, sessionId, scope };
}

test("concurrent turns each see their own context", async () => {
  const seen: (string | null | undefined)[] = [];
  const turn = (id: string, delay: number) =>
    turnContext.run(ctx({ kind: "user", key: id }, id), async () => {
      await new Promise((r) => setTimeout(r, delay));
      seen.push(currentTurn()?.sessionId);
    });
  await Promise.all([turn("a", 20), turn("b", 5)]);
  assert.deepEqual(seen, ["b", "a"]);
  assert.equal(currentTurn(), null);
});

test("active skills are kept per session owner", () => {
  turnContext.run(ctx({ kind: "user", key: "slack:U1" }, "s1"), () => {
    activate("deploy");
    assert.equal(isActive("deploy"), true);
  });
  turnContext.run(ctx({ kind: "user", key: "slack:U2" }, "s2"), () => {
    assert.equal(isActive("deploy"), false);
  });
  // Outside a turn the core set is used, same as inside a core turn.
  turnContext.run(ctx(CORE_SCOPE, "c"), () => activate("notes"));
  assert.deepEqual([...getActiveSkills()], ["notes"]);
});
