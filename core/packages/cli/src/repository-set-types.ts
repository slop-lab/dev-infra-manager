import { type RepositorySetEntry } from "@slop-lab/dim-core";

export interface RepositorySetPlan {
  project: string;
  createProject: boolean;
  actions: Array<{
    action: "create" | "retry" | "unchanged" | "conflict";
    alias: string;
    entry: RepositorySetEntry;
    detail?: string;
  }>;
}
