import { type RepositorySetEntry } from "@slop-lab/dim-core";

export interface RepositorySetPlan {
  project: string;
  createProject: boolean;
  preservedAliases?: string[];
  actions: Array<{
    action: "create" | "retry" | "unchanged" | "conflict" | "rebind";
    alias: string;
    entry: RepositorySetEntry;
    detail?: string;
    expectedOriginDigest?: string;
  }>;
}
