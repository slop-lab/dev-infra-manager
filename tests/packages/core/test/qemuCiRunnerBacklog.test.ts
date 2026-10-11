import { describe, expect, it } from "vitest";
import { ciRunnerContainerLabels, ciRunnerContainerPlan } from "../../../../core/packages/core/src/ciRunnerContainer.js";
import { prepareQemuBacklogReplay } from "../../../../core/packages/core/src/qemuCiRunnerBacklog.js";
import type { QemuCiRunnerExecutor } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";

const record = { projectName: "project", projectId: "project-id", name: "capacity" };
const executor = {
  kind: "qemu", phase: "creating", supervisorName: "supervisor", volumeName: "data",
  image: `sha256:${"a".repeat(64)}`,
  projectHook: { sourceRef: "refs/heads/main", sourceCommit: "b".repeat(40), kind: "absent", digest: "c".repeat(64) },
  resources: { cpus: "4", memory: "8GiB" }, inheritsResources: true,
  labels: ["dim-qemu"], jobImage: `registry.example/job@sha256:${"d".repeat(64)}`, updatedAt: "now"
} satisfies QemuCiRunnerExecutor;

describe("QEMU queued-job replay transport", () => {
  it("uses the inspected immutable container ID across a same-name replacement race", async () => {
    // Given
    const runner = new StatefulContainerRunner();
    const labels = ciRunnerContainerLabels(ciRunnerContainerPlan(record, executor));
    runner.add({ id: "owned-id", name: executor.supervisorName, labels, running: true });
    runner.replaceAfterNextInspect({ id: "replacement-id", name: executor.supervisorName, labels: [], running: true });

    // When
    const replay = await prepareQemuBacklogReplay({ runner, record, executor, authorization: "Bearer test" });
    await replay({ id: 77, labels: ["dim-qemu"] });

    // Then
    const execCalls = runner.calls.filter((call) => call[1] === "exec");
    const health = execCalls.find((call) => call.at(-1) === "http://127.0.0.1:8080/healthz");
    const replayCall = execCalls.find((call) => call.at(-1) === "http://127.0.0.1:8080/workflow-job");
    expect(execCalls).toHaveLength(2);
    expect(execCalls.every((call) => call[2] === "owned-id")).toBe(true);
    expect(execCalls.some((call) => call.includes("replacement-id") || call.includes(executor.supervisorName))).toBe(false);
    expect(execCalls.every((call) => !call.includes("sh") && !call.includes("-c"))).toBe(true);
    expect(health).toEqual(expect.arrayContaining([
      "--retry", "89", "--retry-max-time", "90",
      "--connect-timeout", "1", "--max-time", "2"
    ]));
    expect(replayCall).toEqual(expect.arrayContaining([
      "--connect-timeout", "1", "--max-time", "10"
    ]));
  });
});
