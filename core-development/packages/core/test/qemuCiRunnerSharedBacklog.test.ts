import { afterEach, describe, expect, it, vi } from "vitest";
import { ciRunnerContainerLabels, ciRunnerContainerPlan } from "../../../../core/packages/core/src/ciRunnerContainer.js";
import { prepareSharedQemuBacklogReplay } from "../../../../core/packages/core/src/qemuCiRunnerBacklog.js";
import type { CiRunnerRecord, QemuCiRunnerExecutor, QemuSchedulerProjectConnection } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const connection = {
  projectId: "project-id",
  hostId: "host-a",
  controllerEndpoint: "https://scheduler-control.example",
  supervisorEndpoint: "https://scheduler-worker.example",
  webhookUrl: "https://scheduler.example/v1/webhooks/project-id/workflow-job",
  apiToken: "service-secret",
  webhookToken: "webhook-secret"
} satisfies QemuSchedulerProjectConnection;

const record = {
  projectName: "project",
  projectId: "project-id",
  name: "capacity"
} satisfies Pick<CiRunnerRecord, "projectName" | "projectId" | "name">;

const executor = {
  kind: "qemu",
  phase: "creating",
  supervisorName: "scheduler-supervisor",
  volumeName: "scheduler-volume",
  image: `sha256:${"a".repeat(64)}`,
  projectHook: { sourceRef: "refs/heads/main", sourceCommit: "b".repeat(40), kind: "absent", digest: "c".repeat(64) },
  resources: { cpus: "4", memory: "8GiB" },
  inheritsResources: true,
  labels: ["dim-qemu"],
  jobImage: `runner@sha256:${"d".repeat(64)}`,
  scheduler: { projectId: "project-id", hostId: "host-a" },
  updatedAt: "now"
} satisfies QemuCiRunnerExecutor;

class RecordingRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "inspect") {
      const labels = ciRunnerContainerLabels(ciRunnerContainerPlan(record, executor));
      const values = labels.map((label) => label.slice(label.indexOf("=") + 1));
      return { command, args, stdout: `immutable-supervisor-id|${values.join("|")}\n`, stderr: "", exitCode: 0 };
    }
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }
  async runStreaming(): Promise<number> { return 0; }
}

afterEach(() => vi.unstubAllGlobals());

describe("shared QEMU backlog readiness", () => {
  it("waits for authenticated local worker readiness and seeds only matching demand", async () => {
    // Given
    const runner = new RecordingRunner();
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(init === undefined ? { url } : { url, init });
      return new Response(null, { status: 202 });
    }));

    // When
    const replay = await prepareSharedQemuBacklogReplay(
      { runner, record, executor, authorization: "Bearer local-readiness" },
      connection
    );
    await replay({ id: 41, labels: ["ordinary"] });
    await replay({ id: 42, labels: ["ordinary", "dim-qemu"] });

    // Then
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      "docker", "exec", "immutable-supervisor-id", "--header", "Authorization: Bearer local-readiness",
      "http://127.0.0.1:8080/healthz"
    ]));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://scheduler-control.example/v1/events");
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: "Bearer service-secret",
      "Content-Type": "application/json",
      "X-DIM-Host": "host-a"
    });
    expect(requests[0]?.init?.body).toBe(JSON.stringify({
      projectId: "project-id", action: "queued", jobId: 42, labels: ["ordinary", "dim-qemu"]
    }));
  });
});
