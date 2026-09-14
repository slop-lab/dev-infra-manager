import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCiRunner } from "../../../../core/packages/core/src/ciRunner.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  containerLabelMismatchCases,
  EXPECTED_CONTAINER_LABELS,
  lifecycleOptions,
  ownedContainer,
  STOPPED_SYSBOX_RECORD,
  TEST_PROJECT
} from "./ciRunnerContainerFixture.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";

describe("stopped Sysbox CI runner container ownership", () => {
  let root = "";
  let state: LifecycleState;
  let options: LifecycleOptions;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-ci-container-start-"));
    state = new LifecycleState(root);
    options = lifecycleOptions(root);
    await state.claimProject(TEST_PROJECT);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("inspects all ownership labels and starts the inspected ID", async () => {
    // Given
    const runner = new StatefulContainerRunner();
    runner.add(ownedContainer(STOPPED_SYSBOX_RECORD, "owned-sysbox-id", false));
    await state.writeCiRunner(STOPPED_SYSBOX_RECORD);

    // When
    await startCiRunner(runner, options, { project: STOPPED_SYSBOX_RECORD.projectName, name: STOPPED_SYSBOX_RECORD.name });

    // Then
    const inspect = runner.calls.find((call) => call[1] === "container" && call[2] === "inspect");
    expect(inspect).toEqual([
      "docker", "container", "inspect", STOPPED_SYSBOX_RECORD.executor.containerName, "--format", expect.any(String)
    ]);
    const format = inspect?.at(-1) ?? "";
    for (const key of [
      "dim.managed", "dim.owner", "dim.project", "dim.project-id", "dim.capacity",
      "dim.executor", "dim.resource", "dim.kind", "dim.digest"
    ]) expect(format).toContain(`\"${key}\"`);
    expect(runner.calls).toContainEqual(["docker", "start", "owned-sysbox-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "start", STOPPED_SYSBOX_RECORD.executor.containerName]);
  });

  it.each(containerLabelMismatchCases(EXPECTED_CONTAINER_LABELS.sysbox))(
    "rejects an independent $field mismatch before starting",
    async ({ labels }) => {
    // Given
    const runner = new StatefulContainerRunner();
    runner.add({ id: "unowned-sysbox-id", name: STOPPED_SYSBOX_RECORD.executor.containerName, labels, running: false });
    await state.writeCiRunner(STOPPED_SYSBOX_RECORD);

    // When
    const start = startCiRunner(runner, options, { project: STOPPED_SYSBOX_RECORD.projectName, name: STOPPED_SYSBOX_RECORD.name });

    // Then
    await expect(start).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls.some((call) => call[1] === "start")).toBe(false);
    }
  );

  it.each([
    { case: "incomplete labels", output: `owned-id|${EXPECTED_CONTAINER_LABELS.sysbox.slice(0, -1).map(labelValue).join("|")}` },
    { case: "missing inspected ID", output: `|${EXPECTED_CONTAINER_LABELS.sysbox.map(labelValue).join("|")}` },
    { case: "extra inspect field", output: `owned-id|${EXPECTED_CONTAINER_LABELS.sysbox.map(labelValue).join("|")}|extra` }
  ])("rejects malformed inspect output with $case", async ({ output }) => {
    const runner = new StatefulContainerRunner();
    runner.returnNextInspect(output);
    await state.writeCiRunner(STOPPED_SYSBOX_RECORD);

    await expect(startCiRunner(runner, options, {
      project: STOPPED_SYSBOX_RECORD.projectName,
      name: STOPPED_SYSBOX_RECORD.name
    })).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls.some((call) => call[1] === "start")).toBe(false);
  });

  it("does not classify misleading inspect stderr as absence", async () => {
    const runner = new StatefulContainerRunner();
    runner.failNextInspect(`daemon denied access; no such container: ${STOPPED_SYSBOX_RECORD.executor.containerName}`);
    await state.writeCiRunner(STOPPED_SYSBOX_RECORD);

    await expect(startCiRunner(runner, options, {
      project: STOPPED_SYSBOX_RECORD.projectName,
      name: STOPPED_SYSBOX_RECORD.name
    })).rejects.toThrow(/failed to inspect CI runner container/);
    expect(runner.calls.some((call) => call[1] === "start")).toBe(false);
  });

  it("starts the inspected ID without starting its replacement", async () => {
    // Given
    const runner = new StatefulContainerRunner();
    runner.add(ownedContainer(STOPPED_SYSBOX_RECORD, "owned-sysbox-id", false));
    runner.replaceAfterNextInspect({
      id: "foreign-replacement-id",
      name: STOPPED_SYSBOX_RECORD.executor.containerName,
      labels: ["dim.managed=true", "dim.owner=foreign"],
      running: false
    });
    await state.writeCiRunner(STOPPED_SYSBOX_RECORD);

    // When
    await startCiRunner(runner, options, { project: STOPPED_SYSBOX_RECORD.projectName, name: STOPPED_SYSBOX_RECORD.name });

    // Then
    expect(runner.calls).toContainEqual(["docker", "start", "owned-sysbox-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "start", STOPPED_SYSBOX_RECORD.executor.containerName]);
    expect(runner.current(STOPPED_SYSBOX_RECORD.executor.containerName))
      .toMatchObject({ id: "foreign-replacement-id", running: false });
  });
});

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}
