import type { ProjectRepositoryRecord } from "../lifecycleTypes.js";
import type { RepositoryRefNamespace, RepositorySetEntry } from "../repositorySet.js";

export interface CreateRepositoryInput {
  project: string;
  alias: string;
  protectedPatterns: string[];
  forcePushBlockedPatterns?: string[];
  root: boolean;
  ref?: string;
}

export interface RepositorySetPlanAction {
  action: "create" | "retry" | "unchanged" | "conflict";
  alias: string;
  entry: RepositorySetEntry;
  detail?: string;
}

export interface RepositorySetPlan {
  project: string;
  createProject: boolean;
  actions: RepositorySetPlanAction[];
}

export interface PreparedRepositoryTransfer {
  transferId?: string;
  repository: ProjectRepositoryRecord;
  sourceUrl?: string;
  targetUrl: string;
  writerUsername?: string;
  writerPassword?: string;
}

export interface PreparedRepositorySync {
  projectId: string;
  repositoryAlias: string;
  externalUrl: string;
  refNamespace?: RepositoryRefNamespace;
  writerUsername: string;
  writerPassword: string;
  publishBranches: Record<string, string>;
  syncEndpoint: string;
  syncToken: string;
  syncTimeoutSeconds: number;
}
