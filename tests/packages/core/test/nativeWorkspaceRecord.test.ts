import { describe, expect, it } from "vitest";
import type { NativeWorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { assertWorkspaceRecord } from "../../../../core/packages/core/src/workspaceRecord.js";

const nativeWorkspace = (): NativeWorkspaceRecord => ({
  schemaVersion: 9,
  workspaceId: "A".repeat(43),
  name: "work-1",
  projectId: "project-a",
  projectName: "acme",
  rootRepositoryAlias: "root",
  rootRef: "refs/heads/main",
  rootCommit: "a".repeat(40),
  workspaceDataPath: "/var/lib/dim/workspace-data",
  phase: "ready",
  profiles: [],
  composeProjectName: "dim-work-1",
  containerName: "dim-ws-work-1",
  networkName: "bridge",
  dockerVolumeName: "dim-ws-work-1-docker",
  runtimeBackend: "sysbox",
  kvm: false,
  cpuCount: "2",
  memory: "4g",
  pidsLimit: "2048",
  routes: [],
  gitUserName: "DIM Test",
  gitUserEmail: "dim@example.invalid",
  hostAliases: {},
  projectManifestPath: "/run/dim/project.json",
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
  source: {
    kind: "native",
    serviceId: "native-main",
    snapshot: {
      projectId: "project-a",
      repositoryId: "root",
      protectedRef: "refs/heads/main",
      commit: "a".repeat(40),
      tree: "b".repeat(40)
    },
    policyRevision: "c".repeat(64),
    requiredReviewRevision: "d".repeat(64),
    requiredJobSetRevision: "e".repeat(64)
  }
});

describe("native workspace state", () => {
  it("accepts the strict schema-9 source", () => {
    const record: unknown = nativeWorkspace();

    expect(() => assertWorkspaceRecord(record, "work-1.json")).not.toThrow();
  });

  it("rejects provider Git fields mixed into schema 9", () => {
    const record: unknown = { ...nativeWorkspace(), gitBaseUrl: "http://provider.invalid" };

    expect(() => assertWorkspaceRecord(record, "work-1.json")).toThrow(/mixes native and provider Git state/);
  });

  it("rejects extra native source fields", () => {
    const current = nativeWorkspace();
    const record: unknown = { ...current, source: { ...current.source, credential: "secret" } };

    expect(() => assertWorkspaceRecord(record, "work-1.json")).toThrow(/invalid native source state/);
  });
});
