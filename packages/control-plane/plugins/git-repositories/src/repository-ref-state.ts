import { assertRepositoryBranchBaselines } from "./repository-branch-state.js";
import { assertRepositoryPolicyUpdates, type RepositoryPolicyUpdate } from "./repository-policy-state.js";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { assertNativeProjectRootImportRows } from "./native-project-root-import-state.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
const id = z.string().regex(/^[0-9a-f]{64}$/);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const repositoryRefTransitionSchema = `CREATE TABLE repository_ref_transition (project_id TEXT NOT NULL, repository_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0), transition_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, finalized INTEGER NOT NULL CHECK(finalized IN (0,1)), PRIMARY KEY(project_id,repository_id,sequence), FOREIGN KEY(project_id,repository_id) REFERENCES native_project_root_import(project_id,repository_id)) STRICT`;
const transitionSchema = z.object({ projectId: z.string(), repositoryId: z.string(), sequence: z.number().int().positive(), importNonce: z.string().uuid(), protectedRef: z.string().startsWith("refs/heads/"), proposalRef: z.string().regex(/^refs\/heads\/proposals\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9._/-]+$/).refine((value) => !value.includes("..") && !value.includes("//") && !value.includes("/.") && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock")), expectedCommit: oid, expectedTree: oid, candidateCommit: oid, candidateTree: oid, generationId: id, policyDigest: id, refPolicyRevision: id, authorizationId: id, evidenceDigest: id }).strict().readonly();
export type RepositoryRefTransition = z.infer<typeof transitionSchema>;
export type NativeProjectRootCurrentHead = { readonly projectId: string; readonly repositoryId: string; readonly sequence: number; readonly protectedRef: string; readonly commit: string; readonly tree: string; readonly policyDigest: string };
export function repositoryTransitionId(value: RepositoryRefTransition): string { return createHash("sha256").update("dim-repository-ref-v1\0").update(JSON.stringify(transitionSchema.parse(value))).digest("hex"); }
export function readRepositoryRefTransitions(database: DatabaseSync): readonly { readonly transition: RepositoryRefTransition; readonly finalized: boolean }[] {
  return database.prepare("SELECT * FROM repository_ref_transition ORDER BY project_id,repository_id,sequence").all().map((row) => {
    if (typeof row.record_json !== "string") throw new RepositoryRefStateError("repository ref transition record is invalid");
    const transition = transitionSchema.parse(JSON.parse(row.record_json));
    if (row.project_id !== transition.projectId || row.repository_id !== transition.repositoryId || row.sequence !== transition.sequence || row.transition_id !== repositoryTransitionId(transition) || (row.finalized !== 0 && row.finalized !== 1)) throw new RepositoryRefStateError("repository ref transition identity is invalid");
    return { transition, finalized: row.finalized === 1 };
  });
}
export function assertRepositoryRefTransitions(database: DatabaseSync, policyUpdates?: readonly RepositoryPolicyUpdate[]): void {
  const heads = new Map<string, NativeProjectRootCurrentHead>();
  const imports = assertNativeProjectRootImportRows(database);
  const baselines = assertRepositoryBranchBaselines(database);
  const updates = policyUpdates ?? assertRepositoryPolicyUpdates(database);
  const sequences = new Map<string, number>();
  const pending = new Set<string>();
  for (const { transition, finalized } of readRepositoryRefTransitions(database)) {
    const imported = imports.find((entry) => entry.projectId === transition.projectId && entry.repositoryId === transition.repositoryId && entry.importNonce === transition.importNonce);
    if (imported?.phase !== "repository-imported" || database.prepare("SELECT 1 FROM bundle_activation WHERE generation_id=?").get(transition.generationId) === undefined) throw new RepositoryRefStateError("repository ref transition has no authoritative import or generation");
    const key = `${transition.projectId}/${transition.repositoryId}`;
    const branchKey = `${key}/${transition.protectedRef}`;
    const baseline = baselines.find((entry) => entry.project_id === transition.projectId && entry.repository_id === transition.repositoryId && entry.protected_ref === transition.protectedRef);
    if (transition.protectedRef !== imported.protectedRef && baseline === undefined) throw new RepositoryRefStateError("repository ref transition has no authoritative branch baseline");
    const previous = heads.get(branchKey) ?? { commit: baseline?.seed_commit ?? imported.expectedCommit, tree: baseline?.seed_tree ?? imported.resolvedTree };
    const effectiveDigest = updates.filter((update) => update.project_id === transition.projectId && update.repository_id === transition.repositoryId && update.head_sequence < transition.sequence).at(-1)?.policy_sha256 ?? imported.policyDigest;
    if (pending.has(key) || transition.sequence !== (sequences.get(key) ?? 0) + 1 || (baseline !== undefined && baseline.seed_sequence >= transition.sequence) || transition.expectedCommit !== previous.commit || transition.expectedTree !== previous.tree || transition.policyDigest !== effectiveDigest) throw new RepositoryRefStateError("repository ref transition chain is invalid");
    sequences.set(key, transition.sequence);
    if (!finalized) pending.add(key);
    else heads.set(branchKey, head(transition));
  }
}

function head(value: RepositoryRefTransition): NativeProjectRootCurrentHead { return { projectId: value.projectId, repositoryId: value.repositoryId, sequence: value.sequence, protectedRef: value.protectedRef, commit: value.candidateCommit, tree: value.candidateTree, policyDigest: value.policyDigest }; }
export function readNativeProjectRootCurrentHeadFromDatabase(databasePath: string, projectId: string, repositoryId: string, protectedRef?: string): NativeProjectRootCurrentHead {
  const imported = readNativeProjectRootImportsFromDatabase(databasePath).find((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId);
  if (imported?.phase !== "repository-imported") throw new RepositoryRefStateError("repository has no authoritative import");
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    assertRepositoryRefTransitions(database);
    const ref = protectedRef ?? imported.protectedRef;
    const baseline = assertRepositoryBranchBaselines(database).find((entry) => entry.project_id === projectId && entry.repository_id === repositoryId && entry.protected_ref === ref);
    if (ref !== imported.protectedRef && baseline === undefined) throw new RepositoryRefStateError("repository branch has no authoritative baseline");
    let current: NativeProjectRootCurrentHead = { projectId, repositoryId, sequence: 0, protectedRef: ref, commit: baseline?.seed_commit ?? imported.expectedCommit, tree: baseline?.seed_tree ?? imported.resolvedTree, policyDigest: imported.policyDigest };
    for (const { transition, finalized } of readRepositoryRefTransitions(database)) {
      if (transition.projectId !== projectId || transition.repositoryId !== repositoryId) continue;
      if (!finalized) throw new RepositoryRefStateError("repository ref transition recovery is pending");
      if (transition.protectedRef === ref) current = head(transition);
      // Sequence is the repository-wide serialization cursor; predecessor objects are branch scoped.
      current = { ...current, sequence: transition.sequence };
    }
    const update = assertRepositoryPolicyUpdates(database).filter((entry) => entry.project_id === projectId && entry.repository_id === repositoryId).at(-1);
    return { ...current, policyDigest: update?.policy_sha256 ?? imported.policyDigest };
  } finally { database.close(); }
}
export function readNativeRepositoryHeadsFromDatabase(databasePath: string, projectId: string, repositoryId: string): readonly NativeProjectRootCurrentHead[] {
  const imported = readNativeProjectRootImportsFromDatabase(databasePath).find((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId);
  if (imported?.phase !== "repository-imported") throw new RepositoryRefStateError("repository has no authoritative import");
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  let refs: readonly string[];
  try { refs = [imported.protectedRef, ...assertRepositoryBranchBaselines(database).filter((entry) => entry.project_id === projectId && entry.repository_id === repositoryId).map((entry) => entry.protected_ref)]; }
  finally { database.close(); }
  return refs.map((ref) => readNativeProjectRootCurrentHeadFromDatabase(databasePath, projectId, repositoryId, ref));
}

export function saveRepositoryRefIntent(path: string, input: RepositoryRefTransition): void {
  const transition = transitionSchema.parse(input); const database = new DatabaseSync(path);
  try { database.prepare("INSERT INTO repository_ref_transition(project_id,repository_id,sequence,transition_id,record_json,finalized) VALUES(?,?,?,?,?,0)").run(transition.projectId, transition.repositoryId, transition.sequence, repositoryTransitionId(transition), JSON.stringify(transition)); }
  finally { database.close(); }
}
export function finalizeRepositoryRef(path: string, transition: RepositoryRefTransition): void {
  const database = new DatabaseSync(path);
  try { const result = database.prepare("UPDATE repository_ref_transition SET finalized=1 WHERE transition_id=?").run(repositoryTransitionId(transition)); if (result.changes !== 1) throw new RepositoryRefStateError("repository ref intent is missing"); } finally { database.close(); }
}

export class RepositoryRefStateError extends Error { readonly name = "RepositoryRefStateError"; }

/** Discard only an exact unaccepted transition after Git still proves the old head. */
export function cancelRepositoryRefIntent(path: string, transition: RepositoryRefTransition): void {
  const database = new DatabaseSync(path);
  try {
    const result = database.prepare("DELETE FROM repository_ref_transition WHERE transition_id=? AND finalized=0").run(repositoryTransitionId(transition));
    if (result.changes !== 1) throw new RepositoryRefStateError("pending repository ref intent is missing");
  } finally { database.close(); }
}
