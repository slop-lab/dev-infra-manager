import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseAuthoritativeImportedRootPolicy, type NativeImportedRootPolicy } from "./native-imported-root-policy.js";
import { assertNativeProjectRootImportRows } from "./native-project-root-import-state.js";
import { assertActivatedGeneration, selectRegistration } from "./native-project-registry-state.js";
import { assertRepositoryRefTransitions, readRepositoryRefTransitions, RepositoryRefStateError, type NativeProjectRootCurrentHead } from "./repository-ref-state.js";

export const repositoryPolicyUpdateSchema = `CREATE TABLE repository_policy_update (project_id TEXT NOT NULL, repository_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), head_sequence INTEGER NOT NULL CHECK(head_sequence >= 0), head_commit TEXT NOT NULL, generation_id TEXT NOT NULL REFERENCES bundle_activation(generation_id), previous_policy_sha256 TEXT NOT NULL, policy_sha256 TEXT NOT NULL, policy_json TEXT NOT NULL, PRIMARY KEY(project_id,repository_id,revision), FOREIGN KEY(project_id,repository_id) REFERENCES native_project_root_import(project_id,repository_id)) STRICT`;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const rowSchema = z.object({ project_id: z.string(), repository_id: z.string(), revision: z.number().int().positive(), head_sequence: z.number().int().nonnegative(), head_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), generation_id: digest, previous_policy_sha256: digest, policy_sha256: digest, policy_json: z.string() });
export type RepositoryPolicyUpdate = z.infer<typeof rowSchema> & { readonly policy: NativeImportedRootPolicy };
export function repositoryPolicyDigest(policy: NativeImportedRootPolicy): string { return createHash("sha256").update(JSON.stringify(policy)).digest("hex"); }
export function readRepositoryPolicyUpdates(database: DatabaseSync): readonly RepositoryPolicyUpdate[] {
  return database.prepare("SELECT * FROM repository_policy_update ORDER BY project_id,repository_id,revision").all().map((row) => {
    const parsed = rowSchema.parse(row);
    const policy = parseAuthoritativeImportedRootPolicy(JSON.parse(parsed.policy_json));
    if (JSON.stringify(policy) !== parsed.policy_json || repositoryPolicyDigest(policy) !== parsed.policy_sha256) throw new RepositoryRefStateError("repository policy update digest is invalid");
    return { ...parsed, policy };
  });
}
export function assertRepositoryPolicyUpdates(database: DatabaseSync): readonly RepositoryPolicyUpdate[] {
  const updates = readRepositoryPolicyUpdates(database);
  const imports = assertNativeProjectRootImportRows(database);
  const transitions = readRepositoryRefTransitions(database);
  const previous = new Map<string, RepositoryPolicyUpdate>();
  for (const update of updates) {
    const imported = imports.find((entry) => entry.projectId === update.project_id && entry.repositoryId === update.repository_id);
    const key = `${update.project_id}/${update.repository_id}`;
    const prior = previous.get(key);
    const head = update.head_sequence === 0 ? imported?.expectedCommit : transitions.find(({ transition, finalized }) => finalized && transition.projectId === update.project_id && transition.repositoryId === update.repository_id && transition.sequence === update.head_sequence)?.transition.candidateCommit;
    if (imported?.phase !== "repository-imported" || update.policy.protectedRef !== imported.protectedRef
      || update.revision !== (prior?.revision ?? 0) + 1 || update.previous_policy_sha256 !== (prior?.policy_sha256 ?? imported.policyDigest)
      || update.head_sequence < (prior?.head_sequence ?? 0) || head !== update.head_commit
      || database.prepare("SELECT 1 FROM bundle_activation WHERE generation_id=?").get(update.generation_id) === undefined) throw new RepositoryRefStateError("repository policy update chain is invalid");
    previous.set(key, update);
  }
  return updates;
}
export function readEffectiveRepositoryPolicy(path: string, projectId: string, repositoryId: string): { readonly policy: NativeImportedRootPolicy; readonly policyDigest: string } {
  const database = new DatabaseSync(path, { readOnly: true, defensive: true });
  try {
    const imported = assertNativeProjectRootImportRows(database).find((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId);
    if (imported === undefined) throw new RepositoryRefStateError("repository policy import is missing");
    const update = assertRepositoryPolicyUpdates(database).filter((entry) => entry.project_id === projectId && entry.repository_id === repositoryId).at(-1);
    return update === undefined ? { policy: imported.policy, policyDigest: imported.policyDigest } : { policy: update.policy, policyDigest: update.policy_sha256 };
  } finally { database.close(); }
}
/** Called while holding the repository service mutation queue. The import receipt is immutable. */
export function updateRepositoryPolicy(path: string, input: { readonly projectId: string; readonly repositoryId: string; readonly ownerHostId: string; readonly generationId: string; readonly expectedPolicyDigest: string; readonly expectedProtectedHead: string; readonly policy: NativeImportedRootPolicy }): void {
  const policy = parseAuthoritativeImportedRootPolicy(input.policy);
  const database = new DatabaseSync(path, { defensive: true });
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    try {
      assertActivatedGeneration(database, input.generationId);
      const imported = assertNativeProjectRootImportRows(database).find((entry) => entry.projectId === input.projectId && entry.repositoryId === input.repositoryId);
      const registration = selectRegistration(database, input.projectId, input.repositoryId);
      if (imported?.phase !== "repository-imported" || imported.ownerHostId !== input.ownerHostId || registration?.ownerHostId !== input.ownerHostId) throw new RepositoryRefStateError("repository policy owner conflicts");
      assertRepositoryRefTransitions(database);
      const transitions = readRepositoryRefTransitions(database).filter(({ transition }) => transition.projectId === input.projectId && transition.repositoryId === input.repositoryId);
      if (transitions.some(({ finalized }) => !finalized)) throw new RepositoryRefStateError("repository ref recovery is pending");
      const last = transitions.at(-1)?.transition;
      const head: Pick<NativeProjectRootCurrentHead, "sequence" | "commit"> = last === undefined ? { sequence: 0, commit: imported.expectedCommit } : { sequence: last.sequence, commit: last.candidateCommit };
      const prior = assertRepositoryPolicyUpdates(database).filter((entry) => entry.project_id === input.projectId && entry.repository_id === input.repositoryId).at(-1);
      const currentDigest = prior?.policy_sha256 ?? imported.policyDigest;
      if (currentDigest !== input.expectedPolicyDigest || head.commit !== input.expectedProtectedHead || policy.protectedRef !== imported.protectedRef) throw new RepositoryRefStateError("repository policy compare-and-swap conflicts");
      const nextDigest = repositoryPolicyDigest(policy);
      if (nextDigest !== currentDigest) database.prepare("INSERT INTO repository_policy_update VALUES(?,?,?,?,?,?,?,?,?)").run(input.projectId, input.repositoryId, (prior?.revision ?? 0) + 1, head.sequence, head.commit, input.generationId, currentDigest, nextDigest, JSON.stringify(policy));
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  } finally { database.close(); }
}
