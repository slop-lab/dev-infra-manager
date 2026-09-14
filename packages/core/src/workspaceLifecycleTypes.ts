import type { WorkspaceRecord } from "./lifecycleTypes.js";

export const WORKSPACE_USER = "dim";
export const WORKSPACE_RUNTIME_CONFIG_VERSION = "7";
export const PROJECT_ROOT_SNAPSHOTS = "/run/dim/project-roots";
export const PROJECT_COMPOSE_NAME = "dim-project";

export interface WorkspaceGitEnvironment {
  username: string;
  token: string;
  userName: string;
  userEmail: string;
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
  WorkspaceRecord,
  "rootRef" | "rootCommit" | "rootSnapshotPath" | "repositorySnapshot"
>;
