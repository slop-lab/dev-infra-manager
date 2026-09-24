import { describe, expect, it } from "vitest";
import { assertPersistedQemuScheduler, assertQemuSchedulerTopology } from "../../../../core/packages/core/src/qemuCiRunnerShared.js";
import type { CiRunnerRecord, QemuSchedulerProjectConnection } from "../../../../core/packages/core/src/lifecycleTypes.js";

const scheduler = {
  projectId: "project-id", hostId: "host-a",
  controllerEndpoint: "https://control.example", supervisorEndpoint: "https://worker.example",
  webhookUrl: "https://hook.example/v1/webhooks/project-id/workflow-job",
  hostToken: "host-token", webhookToken: "hook-token"
} satisfies QemuSchedulerProjectConnection;

describe("shared QEMU scheduler topology", () => {
  it("rejects mixed local and shared capacities for one local Project", () => {
    // Given
    const local = record("local");
    const shared = record("shared", { projectId: scheduler.projectId, hostId: scheduler.hostId });

    // When / Then
    expect(() => assertQemuSchedulerTopology([local], "project", scheduler)).toThrow(/mixed local and shared/);
    expect(() => assertQemuSchedulerTopology([shared], "project", undefined)).toThrow(/already uses shared/);
  });

  it("requires start and restart to retain their persisted scheduler identity", () => {
    // Given
    const shared = record("shared", { projectId: scheduler.projectId, hostId: scheduler.hostId });

    // When / Then
    expect(() => assertPersistedQemuScheduler(shared, scheduler)).not.toThrow();
    expect(() => assertPersistedQemuScheduler(shared, { ...scheduler, hostId: "host-b" })).toThrow(/identity changed/);
    expect(() => assertPersistedQemuScheduler(shared, undefined)).toThrow(/mode or identity changed/);
  });
});

function record(name: string, sharedScheduler?: { readonly projectId: string; readonly hostId: string }): CiRunnerRecord {
  return {
    schemaVersion: 8, name, projectId: "project-id", projectName: "project", provider: "gitea",
    config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
    executor: {
      kind: "qemu", phase: "ready", supervisorName: `supervisor-${name}`, volumeName: `volume-${name}`,
      image: `sha256:${"c".repeat(64)}`, projectHook: {
        sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), kind: "absent", digest: "d".repeat(64)
      },
      resources: { cpus: "4", memory: "8GiB" }, inheritsResources: true,
      labels: ["dim-qemu"], jobImage: `runner@sha256:${"e".repeat(64)}`,
      ...(sharedScheduler === undefined ? {} : { scheduler: sharedScheduler }), updatedAt: "now"
    },
    createdAt: "now", updatedAt: "now"
  };
}
