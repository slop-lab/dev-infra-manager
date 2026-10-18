import path from "node:path";
import type { WorkspaceRecord } from "./lifecycleTypes.js";

export const WORKSPACE_USER = "dim";
export const WORKSPACE_RUNTIME_CONFIG_VERSION = "9";
export const PROJECT_ROOT = "/run/dim/project-root";
export const WORKSPACE_DATA = "/var/lib/dim/workspace-data";
export const PROJECT_COMPOSE_NAME = "dim-project";

export interface WorkspaceGitEnvironment {
  username: string;
  token: string;
  userName: string;
  userEmail: string;
  brokerToken?: string;
}

export function workspaceGitBaseUrl(record: WorkspaceRecord): string {
  return `http://127.0.0.1:19418/v1/projects/${record.source.snapshot.projectId}/repositories`;
}

export function workspaceRootSnapshotPath(stateRoot: string, record: WorkspaceRecord): string {
  return path.join(stateRoot, "assets", "native-project-roots", record.projectId, record.rootCommit);
}

export interface WorkspaceCommandInput {
  name: string;
  command: string[];
  interactive: boolean;
}

export interface WorkspaceResourceInput {
  cpuCount?: string;
  memory?: string;
  pidsLimit?: string;
}
