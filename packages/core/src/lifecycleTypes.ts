export interface LifecycleOptions {
  stateRoot: string;
  giteaImage: string;
  giteaHost: string;
  giteaPort: number;
  giteaAdminUsername: string;
  gitUsername: string;
  gitMaintainerUsername: string;
  defaultWorkspaceBackend: WorkspaceRuntimeBackendKind;
  workspaceImage?: string;
  workspaceRuntime?: string;
  workspacePrivileged?: boolean;
  cpuCount: string;
  memory: string;
  pidsLimit: string;
  controllerRuntimeDirectory: string;
  controllerSocketPath: string;
  agentControllerSocketPath: string;
  adminControllerSocketPath: string;
  ciRunnerImage: string;
  ciRunnerRuntime: string;
  ciRunnerDefaultCpus: string;
  ciRunnerDefaultMemory: string;
  ciRunnerDefaultPidsLimit: string;
}

export interface CiRunnerResources {
  cpus: string;
  memory: string;
  pidsLimit: string;
}

export type CiRunnerExecutorKind = "sysbox" | "qemu";
export type CiRunnerPhase = "creating" | "ready" | "stopped" | "error";

export interface SysboxCiRunnerExecutor {
  kind: "sysbox";
  phase: CiRunnerPhase;
  containerName: string;
  volumeName: string;
  image: string;
  runtime: string;
  resources: CiRunnerResources;
  inheritsResources: boolean;
  labels: string[];
  updatedAt: string;
  error?: string;
}

export interface QemuCiRunnerExecutor {
  kind: "qemu";
  phase: CiRunnerPhase;
  supervisorName: string;
  volumeName: string;
  image: string;
  resources: Pick<CiRunnerResources, "cpus" | "memory">;
  inheritsResources: boolean;
  labels: string[];
  updatedAt: string;
  error?: string;
}

export interface CiRunnerRecord {
  schemaVersion: 4;
  name: string;
  projectId: string;
  projectName: string;
  provider: string;
  executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRuntimeBackendKind = "sysbox" | "gvisor" | "rootless-podman" | "runc";

export interface GiteaCredentials {
  adminUsername: string;
  adminPassword: string;
  writerUsername: string;
  writerPassword: string;
  maintainerUsername: string;
  maintainerPassword: string;
}

export interface HostGitCredential {
  username: string;
  password: string;
}

export interface GiteaServiceRecord {
  phase: "creating" | "ready" | "error";
  containerName: string;
  networkName: string;
  volumeName: string;
  image: string;
  port: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type ProjectPhase = "creating" | "ready" | "error";
export type ProjectRepositoryPhase = "creating" | "importing" | "ready" | "error";

export interface RepositoryConnection {
  name: "origin";
  url: string;
  refNamespace?: {
    prefix?: string;
    fallback?: boolean;
    excludedPrefixes?: string[];
    branches?: Record<string, string>;
  };
  publishBranches?: Record<string, string>;
}

export interface ProjectRepositoryRecord {
  alias: string;
  ref?: string;
  providerRepoId: string;
  owner: string;
  hostUrl: string;
  workspaceUrl: string;
  phase: ProjectRepositoryPhase;
  connections: RepositoryConnection[];
  transferId?: string;
  protectedPatterns: string[];
  forcePushBlockedPatterns?: string[];
  protectionPhase: "pending" | "applied";
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ProjectRecord {
  schemaVersion: 3;
  id: string;
  name: string;
  gitNamespace: string;
  phase: ProjectPhase;
  rootRepositoryAlias?: string;
  rootRef?: string;
  repositories: ProjectRepositoryRecord[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type WorkspacePhase = "creating" | "setting-up" | "ready" | "stopped" | "setup-error" | "error";

export interface WorkspaceSetupRecord {
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
}

export type WorkspaceCapabilityRequirement = "required" | "recommended";
export interface WorkspaceCapabilityRecord {
  name: string;
  requirement: WorkspaceCapabilityRequirement;
  status: "provided" | "unavailable";
  plugin?: string;
  detail?: string;
  capabilities?: string[];
  securityOptions?: string[];
  devices?: string[];
  environment?: Record<string, string>;
}

export interface WorkspaceRecord {
  schemaVersion: 3;
  name: string;
  projectId: string;
  projectName: string;
  rootRepositoryAlias: string;
  rootRef: string;
  repositoryRefOverrides?: Record<string, string>;
  projectPath: string;
  phase: WorkspacePhase;
  profiles: string[];
  capabilities?: WorkspaceCapabilityRecord[];
  composeProjectName: string;
  containerName: string;
  networkName: string;
  dockerVolumeName: string;
  runtimeBackend: WorkspaceRuntimeBackendKind;
  kvm: boolean;
  cpuCount: string;
  memory: string;
  pidsLimit: string;
  routes: string[];
  gitUserName: string;
  gitUserEmail: string;
  gitBaseUrl: string;
  hostAliases: Record<string, string[]>;
  projectManifestPath: string;
  createdAt: string;
  updatedAt: string;
  lastSetup?: WorkspaceSetupRecord;
  error?: string;
}
