import type {
  CiRunnerRecord,
  HostLifecycleRecord,
  LifecycleOptions,
  ProjectRecord,
  WorkspacePhase,
  WorkspaceRecord
} from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  hostMirrorInspection,
  type HostMirrorOwnership
} from "../../../../core/packages/core/src/hostMirrorOwnership.js";

export const HOST_PROJECT = {
  schemaVersion: 4,
  id: "project-id",
  name: "example",
  gitNamespace: "dim-example",
  giteaOrganizationId: 41,
  phase: "ready",
  rootRepositoryAlias: "root",
  rootRef: "main",
  repositories: [],
  createdAt: "now",
  updatedAt: "now"
} satisfies ProjectRecord;

export const HOST_QEMU_RUNNER = {
  schemaVersion: 8,
  name: "capacity",
  projectId: HOST_PROJECT.id,
  projectName: HOST_PROJECT.name,
  provider: "gitea-actions",
  config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
  executor: {
    kind: "qemu",
    phase: "error",
    supervisorName: "shared-ci-name",
    volumeName: "ci-data",
    image: `sha256:${"c".repeat(64)}`,
    projectHook: {
      sourceRef: "refs/heads/main",
      sourceCommit: "a".repeat(40),
      kind: "absent",
      digest: "d".repeat(64)
    },
    resources: { cpus: "4", memory: "8g" },
    inheritsResources: true,
    labels: ["dim-container-integration", "dim-qemu"],
    jobImage: `registry.example/job@sha256:${"e".repeat(64)}`,
    updatedAt: "now",
    error: "interrupted"
  },
  createdAt: "now",
  updatedAt: "now"
} satisfies CiRunnerRecord;

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
  input: Pick<HostLifecycleRecord, "resumeWorkspaces" | "restartCiRunners"> = {
    resumeWorkspaces: [],
    restartCiRunners: []
  }
): HostLifecycleRecord {
  return {
    schemaVersion: 2,
    phase,
    ...input,
    resumeManagedContainers: [],
    updatedAt: "now"
  };
}

export function workspaceRecord(name: string, phase: WorkspacePhase): WorkspaceRecord {
  return {
    schemaVersion: 8,
    workspaceId: "A".repeat(43),
    name,
    projectId: HOST_PROJECT.id,
    projectName: HOST_PROJECT.name,
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40),
    workspaceDataPath: "/var/lib/dim/workspace-data",
    phase,
    profiles: [],
    composeProjectName: `dim-${name}`,
    containerName: `dim-ws-${name}`,
    networkName: "dim-gitea",
    dockerVolumeName: `dim-ws-${name}-docker`,
    runtimeBackend: "sysbox",
    kvm: false,
    cpuCount: "4",
    memory: "8g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "DIM Test",
    gitUserEmail: "dim@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-example",
    hostAliases: {},
    projectManifestPath: "/run/dim/project.json",
    createdAt: "now",
    updatedAt: "now"
  };
}

export function hostLifecycleOptions(stateRoot: string): LifecycleOptions {
  seedTestHostMirrorOwnership(stateRoot);
  return {
    stateRoot,
    giteaConnection: { kind: "managed" },
    giteaImage: "gitea/gitea:1.27.0",
    giteaHost: "gitea",
    giteaPort: 3000,
    giteaAdminUsername: "admin",
    gitUsername: "writer",
    gitMaintainerUsername: "maintainer",
    defaultWorkspaceBackend: "sysbox",
    cpuCount: "4",
    memory: "8g",
    pidsLimit: "2048",
    controllerRuntimeDirectory: "/run/dim",
    controllerSocketPath: "/run/dim/controller.sock",
    agentControllerSocketPath: "/run/dim/agent.sock",
    adminControllerSocketPath: "/run/dim/admin.sock",
    ciRunnerImage: "runner",
    ciRunnerRuntime: "sysbox-runc",
    ciRunnerDefaultCpus: "4",
    ciRunnerDefaultMemory: "8g",
    ciRunnerDefaultPidsLimit: "2048",
    hostMirrorProvider: TEST_HOST_MIRROR_PROVIDER
  };
}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
