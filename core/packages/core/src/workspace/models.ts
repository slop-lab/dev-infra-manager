/** Base workspace data. Managed Git and CI attach through integrations. */
export interface WorkspaceSource {
  url: string;
  ref?: string;
}

export interface AcquiredWorkspaceSource {
  url: string;
  ref: string;
  commit: string;
}

export interface WorkspaceResources {
  cpuCount: string;
  memory: string;
  pidsLimit: string;
}

export interface WorkspaceRecord {
  schemaVersion: 10;
  id: string;
  name: string;
  source: AcquiredWorkspaceSource;
  runtime: string;
  image: string;
  resources: WorkspaceResources;
  git: { name: string; email: string };
  initialized: boolean;
  phase: "creating" | "running" | "stopped" | "error" | "discarding";
  createdAt: string;
  updatedAt: string;
  error?: string;
}

/** Observation is returned to clients; it never rewrites desired or recovery state. */
export interface WorkspaceView extends WorkspaceRecord {
  runtimeStatus: "running" | "stopped" | "missing" | "unavailable";
  runtimeError?: string;
}
