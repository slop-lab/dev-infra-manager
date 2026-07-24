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

export interface RepoRecord {
  name: string;
  owner: string;
  cloneUrl: string;
  sourcePath: string;
  phase: "importing" | "ready" | "error";
  protectedPatterns: string[];
  registeredAt: string;
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
  name: string;
  project: string;
  projectPath: string;
  phase: WorkspacePhase;
  profiles: string[];
  composeProjectName: string;
  containerName: string;
  networkName: string;
  dockerVolumeName: string;
  runtimeBackend: WorkspaceRuntimeBackendKind;
  routes: string[];
  gitUserName: string;
  gitUserEmail: string;
  gitBaseUrl: string;
  createdAt: string;
  updatedAt: string;
  lastSetup?: WorkspaceSetupRecord;
  error?: string;
}
