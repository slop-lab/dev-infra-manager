export interface LifecycleOptions {
  stateRoot: string;
  giteaImage: string;
  giteaPort: number;
  giteaAdminUsername: string;
  gitUsername: string;
  defaultWorkspaceBackend: WorkspaceRuntimeBackendKind;
  workspaceImage?: string;
  workspaceRuntime?: string;
  workspacePrivileged?: boolean;
  cpuCount: string;
  memory: string;
  pidsLimit: string;
  controllerSocketPath: string;
  adminControllerSocketPath: string;
  agentDockerSocketPath: string;
}

export type WorkspaceRuntimeBackendKind = "sysbox" | "gvisor" | "rootless-podman" | "runc";

export interface GiteaCredentials {
  adminUsername: string;
  adminPassword: string;
  writerUsername: string;
  writerPassword: string;
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
export type ProjectRepositoryPhase = "creating" | "ready" | "error";

export interface ProjectRepositoryRecord {
  alias: string;
  providerRepoId: string;
  owner: string;
  hostUrl: string;
  workspaceUrl: string;
  phase: ProjectRepositoryPhase;
  protectedPatterns: string[];
  protectionPhase: "pending" | "applied";
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ProjectRecord {
  schemaVersion: 2;
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

export interface WorkspaceRecord {
  schemaVersion: 2;
  name: string;
  projectId: string;
  projectName: string;
  rootRepositoryAlias: string;
  rootRef: string;
  projectPath: string;
  phase: WorkspacePhase;
  profiles: string[];
  composeProjectName: string;
  containerName: string;
  networkName: string;
  dockerVolumeName: string;
  runtimeBackend: WorkspaceRuntimeBackendKind;
  agentContainerName?: string;
  agentCheckoutVolumeName?: string;
  agentDockerVolumeName?: string;
  agentImageName?: string;
  kvm?: boolean;
  cpuCount: string;
  memory: string;
  pidsLimit: string;
  routes: string[];
  gitUserName: string;
  gitUserEmail: string;
  gitBaseUrl: string;
  projectManifestPath: string;
  createdAt: string;
  updatedAt: string;
  lastSetup?: WorkspaceSetupRecord;
  error?: string;
}
