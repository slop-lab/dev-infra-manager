import { createHash } from "node:crypto";
import type {
  NativeWorkspaceRecord,
  ProjectRecord
} from "../../../../core/packages/core/src/lifecycleTypes.js";
import { compileNativeRootBootstrapPolicy } from "../../../../core/packages/core/src/nativeRootBootstrapPolicy.js";

const createdAt = "2026-10-11T00:00:00.000Z";
const reviewPolicy = compileNativeRootBootstrapPolicy({
  rootAlias: "root",
  protectedRef: "refs/heads/main",
  review: { requiredReviewerIds: ["owner"], pathReviewerRules: [], requiredJobs: [] }
}).reviewPolicy;

export function nativeProjectFixture(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const projectId = overrides.projectId ?? "project-id";
  const protectedRef = overrides.protectedRef ?? "refs/heads/main";
  const rootCommit = overrides.rootCommit ?? "a".repeat(40);
  const rootTree = overrides.rootTree ?? "b".repeat(40);
  const bundleDigest = overrides.bundleDigest ?? "c".repeat(64);
  const bundleSize = overrides.bundleSize ?? 123;
  const selectedReviewPolicy = overrides.reviewPolicy ?? reviewPolicy;
  return {
    schemaVersion: 6,
    recordType: "native-project",
    phase: "ready",
    name: "project",
    projectId,
    serviceId: "native-main",
    ownerHostId: "host-a",
    rootRepositoryId: "root",
    rootAlias: "root",
    protectedRef,
    rootCommit,
    rootTree,
    reviewPolicy: selectedReviewPolicy,
    bundleDigest,
    bundleSize,
    importReceipt: {
      schemaVersion: 1,
      serviceId: "native-main",
      projectId,
      rootRepositoryId: "root",
      generationId: "d".repeat(64),
      importNonce: "00000000-0000-4000-8000-000000000000",
      protectedRef,
      expectedCommit: rootCommit,
      policyDigest: createHash("sha256").update(JSON.stringify(selectedReviewPolicy)).digest("hex"),
      bundleDigest,
      bundleSize,
      resolvedTree: rootTree,
      phase: "root-imported"
    },
    readyAt: createdAt,
    ...overrides
  };
}

export function nativeWorkspaceFixture(
  overrides: Partial<NativeWorkspaceRecord> = {}
): NativeWorkspaceRecord {
  const projectId = overrides.projectId ?? "project-id";
  const rootRef = overrides.rootRef ?? "refs/heads/main";
  const rootCommit = overrides.rootCommit ?? "a".repeat(40);
  return {
    schemaVersion: 9,
    workspaceId: "A".repeat(43),
    name: "work-1",
    projectId,
    projectName: "project",
    rootRepositoryAlias: "root",
    rootRef,
    rootCommit,
    workspaceDataPath: "/var/lib/dim/workspace-data",
    environment: "custom",
    phase: "ready",
    profiles: [],
    composeProjectName: "dim-work-1",
    containerName: "dim-ws-work-1",
    networkName: "dim-control",
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
    createdAt,
    updatedAt: createdAt,
    source: {
      kind: "native",
      serviceId: "native-main",
      snapshot: {
        projectId,
        repositoryId: "root",
        protectedRef: rootRef,
        commit: rootCommit,
        tree: "b".repeat(40)
      },
      policyRevision: "c".repeat(64),
      requiredReviewRevision: "d".repeat(64),
      requiredJobSetRevision: "e".repeat(64)
    },
    ...overrides
  };
}
