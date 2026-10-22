import { nativeImportedRootPolicySchema } from "./native-imported-root-policy.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { assertNativeProjectRootImportRows } from "./native-project-root-import-state.js";
import { readRepositoryRefTransitions, RepositoryRefStateError } from "./repository-ref-state.js";

/** A branch starts only at a recorded authoritative snapshot, never at an untrusted existing Git ref. */
export const repositoryBranchBaselineSchema = `CREATE TABLE repository_branch_baseline (project_id TEXT NOT NULL, repository_id TEXT NOT NULL, protected_ref TEXT NOT NULL, import_nonce TEXT NOT NULL, seed_sequence INTEGER NOT NULL CHECK(seed_sequence >= 0), seed_commit TEXT NOT NULL, seed_tree TEXT NOT NULL, PRIMARY KEY(project_id,repository_id,protected_ref), FOREIGN KEY(project_id,repository_id) REFERENCES native_project_root_import(project_id,repository_id)) STRICT`;
const baselineSchema = z.object({ project_id: z.string(), repository_id: z.string(), protected_ref: nativeImportedRootPolicySchema.unwrap().shape.protectedRef, import_nonce: z.string().uuid(), seed_sequence: z.number().int().nonnegative(), seed_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), seed_tree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) });
export type RepositoryBranchBaseline = z.infer<typeof baselineSchema>;
export function readRepositoryBranchBaselines(database: DatabaseSync): readonly RepositoryBranchBaseline[] {
  // Read-only inspection of the supported pre-branch state format has no baseline table.
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name='repository_branch_baseline'").get() === undefined) return [];
  return database.prepare("SELECT * FROM repository_branch_baseline ORDER BY project_id,repository_id,protected_ref").all().map((row) => baselineSchema.parse(row));
}
export function assertRepositoryBranchBaselines(database: DatabaseSync): readonly RepositoryBranchBaseline[] {
  const baselines = readRepositoryBranchBaselines(database);
  const imports = assertNativeProjectRootImportRows(database);
  const transitions = readRepositoryRefTransitions(database);
  for (const baseline of baselines) {
    const imported = imports.find((entry) => entry.projectId === baseline.project_id && entry.repositoryId === baseline.repository_id);
    const source = baseline.seed_sequence === 0 ? imported?.phase === "repository-imported" ? { commit: imported.expectedCommit, tree: imported.resolvedTree } : undefined
      : transitions.find(({ transition, finalized }) => finalized && transition.projectId === baseline.project_id && transition.repositoryId === baseline.repository_id && transition.sequence === baseline.seed_sequence)?.transition;
    const commit = source !== undefined && "candidateCommit" in source ? source.candidateCommit : source?.commit;
    const tree = source !== undefined && "candidateTree" in source ? source.candidateTree : source?.tree;
    if (imported?.phase !== "repository-imported" || imported.importNonce !== baseline.import_nonce || imported.protectedRef === baseline.protected_ref || (source !== undefined && "protectedRef" in source && source.protectedRef !== imported.protectedRef) || commit !== baseline.seed_commit || tree !== baseline.seed_tree) throw new RepositoryRefStateError("repository branch baseline has no authoritative seed");
  }
  return baselines;
}
