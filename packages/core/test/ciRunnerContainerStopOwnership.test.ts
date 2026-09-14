import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopCiRunner } from "../../../../core/packages/core/src/ciRunner.js";
import { giteaCiCoordinator } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord, LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  containerLabelMismatchCases,
  EXPECTED_CONTAINER_LABELS,
  lifecycleOptions,
  ownedContainer,
  READY_QEMU_RECORD,
  STOPPED_SYSBOX_RECORD,
  TEST_PROJECT
} from "./ciRunnerContainerFixture.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";

type StopCase = {
  readonly label: string;
  readonly record: CiRunnerRecord;
  readonly containerName: string;
};

const stopCases = [
  {
    label: "Sysbox runner",
    record: { ...STOPPED_SYSBOX_RECORD, executor: { ...STOPPED_SYSBOX_RECORD.executor, phase: "ready" } },
    containerName: STOPPED_SYSBOX_RECORD.executor.containerName
  },
  { label: "QEMU supervisor", record: READY_QEMU_RECORD, containerName: READY_QEMU_RECORD.executor.supervisorName }
] satisfies readonly StopCase[];

const ownershipCases = stopCases.flatMap((testCase) =>
  containerLabelMismatchCases(EXPECTED_CONTAINER_LABELS[testCase.record.executor.kind])
    .map((mismatch) => ({ ...testCase, ...mismatch }))
);

describe("CI runner container stop ownership", () => {
  let root = "";
  let state: LifecycleState;
  let options: LifecycleOptions;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-ci-container-stop-"));
    state = new LifecycleState(root);
    options = lifecycleOptions(root);
    await state.claimProject(TEST_PROJECT);
    vi.spyOn(giteaCiCoordinator, "removeWorkflowJobWebhook").mockResolvedValue();
    vi.spyOn(giteaCiCoordinator, "reconcileWorkflowJobWebhookTargets").mockResolvedValue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each(stopCases)("inspects complete ownership and stops the inspected $label ID", async (testCase) => {
    // Given
    const runner = new StatefulContainerRunner();
    runner.add(ownedContainer(testCase.record, `owned-${testCase.record.executor.kind}-id`, true));
    await state.writeCiRunner(testCase.record);

    // When
    await stopCiRunner(runner, options, testCase.record.projectName, testCase.record.name);

    // Then
    const inspect = runner.calls.find((call) => call[1] === "container" && call[2] === "inspect");
    expect(inspect).toEqual(["docker", "container", "inspect", testCase.containerName, "--format", expect.any(String)]);
    expect(inspect?.at(-1)).toContain("dim.digest");
    expect(runner.calls).toContainEqual(["docker", "stop", `owned-${testCase.record.executor.kind}-id`]);
    expect(runner.calls).not.toContainEqual(["docker", "stop", testCase.containerName]);
  });

  it.each(ownershipCases)("rejects an independent $field mismatch before stopping a $label", async (testCase) => {
    // Given
    const runner = new StatefulContainerRunner();
    runner.add({ id: "unowned-id", name: testCase.containerName, labels: testCase.labels, running: true });
    await state.writeCiRunner(testCase.record);

    // When
    const stop = stopCiRunner(runner, options, testCase.record.projectName, testCase.record.name);

    // Then
    await expect(stop).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls.some((call) => call[1] === "stop")).toBe(false);
    expect(giteaCiCoordinator.removeWorkflowJobWebhook).not.toHaveBeenCalled();
    await expect(state.readCiRunner(testCase.record.projectName, testCase.record.name))
      .resolves.toMatchObject({ executor: { phase: "ready" } });
  });

  it.each(stopCases)("fails closed on misleading absence text while stopping a $label", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.failNextInspect(`permission denied: no such container: ${testCase.containerName}`);
    await state.writeCiRunner(testCase.record);

    await expect(stopCiRunner(runner, options, testCase.record.projectName, testCase.record.name))
      .rejects.toThrow(/failed to inspect CI runner container/);
    expect(runner.calls.some((call) => call[1] === "stop")).toBe(false);
    expect(giteaCiCoordinator.removeWorkflowJobWebhook).not.toHaveBeenCalled();
    await expect(state.readCiRunner(testCase.record.projectName, testCase.record.name))
      .resolves.toMatchObject({ executor: { phase: "ready" } });
  });

  it.each(stopCases)("stops the inspected $label ID without stopping its replacement", async (testCase) => {
    // Given
    const runner = new StatefulContainerRunner();
    runner.add(ownedContainer(testCase.record, "owned-id", true));
    runner.replaceAfterNextInspect({
      id: "foreign-replacement-id",
      name: testCase.containerName,
      labels: ["dim.managed=true", "dim.owner=foreign"],
      running: true
    });
    await state.writeCiRunner(testCase.record);

    // When
    await stopCiRunner(runner, options, testCase.record.projectName, testCase.record.name);

    // Then
    expect(runner.calls).toContainEqual(["docker", "stop", "owned-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "stop", testCase.containerName]);
    expect(runner.current(testCase.containerName)).toMatchObject({ id: "foreign-replacement-id", running: true });
  });

  it.each(stopCases)("tolerates an exact inspected-ID absence while stopping a $label", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.add(ownedContainer(testCase.record, "disappearing-id", true));
    runner.disappearAfterNextInspect();
    await state.writeCiRunner(testCase.record);

    const stopped = await stopCiRunner(runner, options, testCase.record.projectName, testCase.record.name);

    expect(stopped.executor.phase).toBe("stopped");
    expect(runner.calls).toContainEqual(["docker", "stop", "disappearing-id"]);
  });

  it.each(stopCases)("rejects misleading stop stderr for a $label", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.add(ownedContainer(testCase.record, "owned-id", true));
    runner.failNextStop("permission denied; No such container: owned-id");
    await state.writeCiRunner(testCase.record);

    await expect(stopCiRunner(runner, options, testCase.record.projectName, testCase.record.name))
      .rejects.toThrow(/failed to stop CI runner container/);
    expect(giteaCiCoordinator.removeWorkflowJobWebhook).not.toHaveBeenCalled();
    await expect(state.readCiRunner(testCase.record.projectName, testCase.record.name))
      .resolves.toMatchObject({ executor: { phase: "ready" } });
  });

  it.each(stopCases)("treats an absent $label as an idempotent stop", async (testCase) => {
    // Given
    const runner = new StatefulContainerRunner();
    await state.writeCiRunner(testCase.record);

    // When
    const stopped = await stopCiRunner(runner, options, testCase.record.projectName, testCase.record.name);

    // Then
    expect(stopped.executor.phase).toBe("stopped");
    expect(runner.calls).toContainEqual([
      "docker", "container", "inspect", testCase.containerName, "--format", expect.any(String)
    ]);
    expect(runner.calls.some((call) => call[1] === "stop")).toBe(false);
  });

  it("acquires the Project lock before the CI-runner lock and releases them in reverse order", async () => {
    // Given
    const events: string[] = [];
    const acquireProjectLock = LifecycleState.prototype.acquireProjectLock;
    const acquireCiRunnerLock = LifecycleState.prototype.acquireCiRunnerLock;
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockImplementation(async function (this: LifecycleState, project) {
      const release = await acquireProjectLock.call(this, project);
      events.push("project:lock");
      return async () => {
        await release();
        events.push("project:unlock");
      };
    });
    vi.spyOn(LifecycleState.prototype, "acquireCiRunnerLock").mockImplementation(async function (this: LifecycleState, project) {
      const release = await acquireCiRunnerLock.call(this, project);
      events.push("runner:lock");
      return async () => {
        await release();
        events.push("runner:unlock");
      };
    });
    const runner = new StatefulContainerRunner();
    runner.add(ownedContainer(READY_QEMU_RECORD, "owned-qemu-id", true));
    await state.writeCiRunner(READY_QEMU_RECORD);

    // When
    await stopCiRunner(runner, options, READY_QEMU_RECORD.projectName, READY_QEMU_RECORD.name);

    // Then
    expect(events).toEqual(["project:lock", "runner:lock", "runner:unlock", "project:unlock"]);
  });
});
