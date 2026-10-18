import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostLifecycleRecord, LifecycleOptions, WorkspacePhase, WorkspaceRecord
} from "../../../../core/packages/managed/src/lifecycleTypes.js";
import {
  hostMirrorInspection,
  type HostMirrorOwnership
} from "../../../../core/packages/managed/src/hostMirrorOwnership.js";

export const TEST_HOST_MIRROR_PROVIDER = {
  dockerImage: "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33",
  aptImage: "sameersbn/apt-cacher-ng@sha256:58e74113cfac7e593201444648c105351cbfce7538bfb36dcafdc9479b2aefcc"
} as const;

export const TEST_HOST_MIRROR_OWNERSHIP = {
  schemaVersion: 1,
  serviceId: "M".repeat(43),
  resourceIds: {
    "control-network": "N".repeat(43),
    "registry-cache-data": "V".repeat(43),
    "registry-cache": "R".repeat(43),
    "apt-cache-data": "D".repeat(43),
    "apt-cache": "A".repeat(43)
  }
} satisfies HostMirrorOwnership;

export function seedTestHostMirrorOwnership(stateRoot: string): void {
  mkdirSync(join(stateRoot, "services"), { recursive: true });
  writeFileSync(join(stateRoot, "services", "host-mirrors.json"), `${JSON.stringify(TEST_HOST_MIRROR_OWNERSHIP)}\n`);
}

export function registryCacheInspect(image: string, id = "registry-id"): string {
  return `${id}|${hostMirrorInspection("registry-cache", TEST_HOST_MIRROR_OWNERSHIP)}|true|${image}|dim-control|volume:dim-registry-cache-data:/var/lib/registry:true|${JSON.stringify([
    "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
    "REGISTRY_PROXY_TTL=168h",
    "REGISTRY_STORAGE_DELETE_ENABLED=true",
    "REGISTRY_LOG_LEVEL=info",
    "OTEL_TRACES_EXPORTER=none"
  ])}|unless-stopped|${JSON.stringify(["dim-registry-cache"])}\n`;
}

export function hostRecord(
  phase: HostLifecycleRecord["phase"],
  input: Pick<HostLifecycleRecord, "resumeWorkspaces"> = { resumeWorkspaces: [] }
): HostLifecycleRecord {
  return {
    schemaVersion: 2,
    phase,
    ...input,
    updatedAt: "now"
  };
}

export function workspaceRecord(name: string, phase: WorkspacePhase): WorkspaceRecord {
  return {
    schemaVersion: 9,
    workspaceId: "A".repeat(43),
    name,
    projectId: "project-id",
    projectName: "example",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40),
    workspaceDataPath: "/var/lib/dim/workspace-data",
    phase,
    profiles: [],
    composeProjectName: `dim-${name}`,
    containerName: `dim-ws-${name}`,
    networkName: "bridge",
    dockerVolumeName: `dim-ws-${name}-docker`,
    runtimeBackend: "sysbox",
    kvm: false,
    cpuCount: "4",
    memory: "8g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "DIM Test",
    gitUserEmail: "dim@example.invalid",
    hostAliases: {},
    projectManifestPath: "/run/dim/project.json",
    source: {
      kind: "native",
      serviceId: "native-main",
      snapshot: {
        projectId: "project-id",
        repositoryId: "root",
        protectedRef: "refs/heads/main",
        commit: "a".repeat(40),
        tree: "b".repeat(40)
      },
      policyRevision: "c".repeat(64),
      requiredReviewRevision: "d".repeat(64),
      requiredJobSetRevision: "e".repeat(64)
    },
    createdAt: "now",
    updatedAt: "now"
  };
}

export function hostLifecycleOptions(stateRoot: string): LifecycleOptions {
  seedTestHostMirrorOwnership(stateRoot);
  return {
    stateRoot,
    nativeControlPlaneConnection: { file: join(stateRoot, "native-control.json") },
    defaultWorkspaceBackend: "sysbox",
    cpuCount: "4",
    memory: "8g",
    pidsLimit: "2048",
    controllerRuntimeDirectory: "/run/dim",
    controllerSocketPath: "/run/dim/controller.sock",
    agentControllerSocketPath: "/run/dim/agent.sock",
    adminControllerSocketPath: "/run/dim/admin.sock",
    hostMirrorProvider: TEST_HOST_MIRROR_PROVIDER
  };
}
