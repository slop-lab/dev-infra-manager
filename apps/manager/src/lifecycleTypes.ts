export interface LifecycleOptions {
  stateRoot: string;
  giteaImage: string;
  giteaPort: number;
  giteaAdminUsername: string;
  gitUsername: string;
  workspaceImage: string;
  workspaceRuntime: string;
  workspacePrivileged: boolean;
  cpuCount: string;
  memory: string;
  pidsLimit: string;
}

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

export type WorkspacePhase = "creating" | "ready" | "error";

export interface WorkspaceRecord {
  name: string;
  repo: string;
  phase: WorkspacePhase;
  containerName: string;
  networkName: string;
  dockerVolumeName: string;
  routes: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}
