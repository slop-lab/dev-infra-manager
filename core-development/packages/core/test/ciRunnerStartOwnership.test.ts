import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containerLabelMismatchCases } from "./ciRunnerContainerFixture.js";
import {
  type QemuStartContext,
  type ReconciliationMode,
  reconciledSupervisorLabels,
  reconcileWithFixture,
  setUpQemuStartTest,
  StartRunner,
  stoppedSupervisorLabels,
  tearDownQemuStartTest,
  testState
} from "./ciRunnerStartHarness.js";

const modes = ["start", "restart", "create"] as const;
const ownershipCases = modes.flatMap((mode) => {
  const expected = mode === "start" ? stoppedSupervisorLabels : reconciledSupervisorLabels;
  return [
    ...containerLabelMismatchCases(expected),
    { field: "incomplete tuple", labels: expected.slice(0, -1) }
  ].map((ownership) => ({ mode, ...ownership }));
});

describe("QEMU CI runner supervisor ownership ordering", () => {
  let context: QemuStartContext;

  beforeEach(async () => { context = await setUpQemuStartTest(); });
  afterEach(async () => { await tearDownQemuStartTest(context); });

  it.each(ownershipCases)(
    "authorizes a $mode supervisor before mutation when $field is invalid",
    async ({ mode, labels }) => {
      const runner = new StartRunner({
        id: "foreign-supervisor-id",
        name: supervisorName(mode, context),
        labels,
        running: false
      });

      await expect(reconcileWithFixture(mode, runner, context)).rejects.toThrow(/conflicts with DIM ownership/);
      await expectCoordinatorAndStateUnchanged(mode, context);
    }
  );

  it.each(modes)("rejects malformed inspected identity before coordinator mutation on $mode", async (mode) => {
    const runner = new StartRunner({
      id: "",
      name: supervisorName(mode, context),
      labels: mode === "start" ? stoppedSupervisorLabels : reconciledSupervisorLabels,
      running: false
    });

    await expect(reconcileWithFixture(mode, runner, context)).rejects.toThrow(/conflicts with DIM ownership/);
    await expectCoordinatorAndStateUnchanged(mode, context);
  });
});

function supervisorName(mode: ReconciliationMode, context: QemuStartContext): string {
  return mode === "start" ? context.record.executor.supervisorName : "dim-ci-project-runner-qemu-supervisor";
}

async function expectCoordinatorAndStateUnchanged(mode: ReconciliationMode, context: QemuStartContext): Promise<void> {
  expect(testState.events).not.toContain("runtime:remove-webhook");
  expect(testState.events).not.toContain("runtime:remove-registration");
  expect(testState.events).not.toContain("runtime:register");
  if (mode === "create") {
    await expect(context.state.readCiRunner(context.record.projectName, context.record.name)).rejects.toThrow(/not found/);
  } else {
    await expect(context.state.readCiRunner(context.record.projectName, context.record.name)).resolves.toEqual(context.record);
  }
}
