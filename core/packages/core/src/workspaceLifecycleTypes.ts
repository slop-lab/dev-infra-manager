import type { GiteaCredentials, WorkspaceRecord } from "./lifecycleTypes.js";
import type { ProtectedRootSnapshot } from "./protectedRootSnapshot.js";

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
}

export function workspaceGitEnvironment(
  record: WorkspaceRecord,
  credentials: GiteaCredentials
): WorkspaceGitEnvironment {
  return {
    username: credentials.writerUsername,
    token: credentials.writerPassword,
    userName: record.gitUserName,
    userEmail: record.gitUserEmail
  };
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

export type WorkspacePublicationTarget = Pick<
  ProtectedRootSnapshot,
  "rootRef" | "rootCommit" | "rootSnapshotPath"
>;
