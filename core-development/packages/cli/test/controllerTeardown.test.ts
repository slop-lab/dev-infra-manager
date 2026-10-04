import assert from "node:assert/strict";
import test from "node:test";
import {
  disposeControllerPlugins,
  disposeHostRuntime
} from "../../../../core/packages/cli/src/controller-teardown.js";

test("controller plugin disposal stops waiting at the shutdown deadline", async () => {
  let finishDisposal = (): void => undefined;
  const disposal = new Promise<void>((resolve) => { finishDisposal = resolve; });
  const startedAt = Date.now();

  assert.equal(await disposeControllerPlugins({ dispose: () => disposal }), false);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 900, `plugin disposal returned before its grace period (${elapsed}ms)`);
  assert.ok(elapsed < 2_000, `plugin disposal exceeded its deadline (${elapsed}ms)`);

  finishDisposal();
});

test("controller host runtime disposal stops waiting at its shutdown deadline", async () => {
  let finishDisposal = (): void => undefined;
  const disposal = new Promise<void>((resolve) => { finishDisposal = resolve; });
  const events: string[] = [];
  const startedAt = Date.now();

  assert.equal(await disposeHostRuntime({
    dispose() {
      events.push("dispose");
      return disposal;
    },
  }, 20), false);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 15, `host runtime disposal returned before its grace period (${elapsed}ms)`);
  assert.ok(elapsed < 500, `host runtime disposal exceeded its deadline (${elapsed}ms)`);
  assert.deepEqual(events, ["dispose"]);

  finishDisposal();
});
