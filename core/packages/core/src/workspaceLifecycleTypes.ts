import path from "node:path";
import type { GiteaCredentials, WorkspaceRecord } from "./lifecycleTypes.js";
import type { ProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import { protectedRootSnapshotPath } from "./protectedRootSnapshot.js";

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

export function workspaceGitBaseUrl(record: WorkspaceRecord): string {
  return record.schemaVersion === 9
    ? `http://127.0.0.1:19418/v1/projects/${record.source.snapshot.projectId}/repositories`
    : record.gitBaseUrl;
}

export function workspaceRootSnapshotPath(stateRoot: string, record: WorkspaceRecord): string {
  return record.schemaVersion === 9
    ? path.join(stateRoot, "assets", "native-project-roots", record.projectId, record.rootCommit)
    : protectedRootSnapshotPath(stateRoot, record.projectId, record.rootCommit);
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
