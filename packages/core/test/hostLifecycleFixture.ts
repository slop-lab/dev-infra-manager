import type {
  CiRunnerRecord,
  HostLifecycleRecord,
  LifecycleOptions,
  ProjectRecord,
  WorkspacePhase,
  WorkspaceRecord
} from "../../../../core/packages/core/src/lifecycleTypes.js";

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
    schemaVersion: 6,
    name,
    projectId: HOST_PROJECT.id,
    projectName: HOST_PROJECT.name,
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40),
    rootSnapshotPath: `/snapshots/${name}`,
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
  return {
    stateRoot,
    giteaConnection: { kind: "managed" },
    giteaImage: "gitea",
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
    ciRunnerDefaultPidsLimit: "2048"
  };
}
