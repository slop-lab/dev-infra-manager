import assert from "node:assert/strict";
import test from "node:test";
import { disposeControllerPlugins } from "../../../../core/packages/cli/src/controller-teardown.js";

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
