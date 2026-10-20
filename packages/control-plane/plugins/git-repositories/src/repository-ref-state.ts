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
export function assertRepositoryRefTransitions(database: DatabaseSync): void {
  const heads = new Map<string, NativeProjectRootCurrentHead>();
  const imports = assertNativeProjectRootImportRows(database);
  for (const { transition, finalized } of readRepositoryRefTransitions(database)) {
    const imported = imports.find((entry) => entry.projectId === transition.projectId && entry.repositoryId === transition.repositoryId && entry.importNonce === transition.importNonce);
    if (imported?.phase !== "repository-imported" || transition.protectedRef !== imported.protectedRef || transition.policyDigest !== imported.policyDigest || database.prepare("SELECT 1 FROM bundle_activation WHERE generation_id=?").get(transition.generationId) === undefined) throw new RepositoryRefStateError("repository ref transition has no authoritative import or generation");
    const key = `${transition.projectId}/${transition.repositoryId}`;
    const previous = heads.get(key) ?? { projectId: imported.projectId, repositoryId: imported.repositoryId, sequence: 0, protectedRef: imported.protectedRef, commit: imported.expectedCommit, tree: imported.resolvedTree, policyDigest: imported.policyDigest };
    if (transition.sequence !== previous.sequence + 1 || transition.expectedCommit !== previous.commit || transition.expectedTree !== previous.tree || transition.policyDigest !== previous.policyDigest) throw new RepositoryRefStateError("repository ref transition chain is invalid");
    if (!finalized) { if (heads.has(`${key}/pending`)) throw new RepositoryRefStateError("multiple pending repository ref transitions"); heads.set(`${key}/pending`, head(transition)); }
    else { if (heads.has(`${key}/pending`)) throw new RepositoryRefStateError("finalized transition follows pending ref transition"); heads.set(key, head(transition)); }
  }
}
function head(value: RepositoryRefTransition): NativeProjectRootCurrentHead { return { projectId: value.projectId, repositoryId: value.repositoryId, sequence: value.sequence, protectedRef: value.protectedRef, commit: value.candidateCommit, tree: value.candidateTree, policyDigest: value.policyDigest }; }
export function readNativeProjectRootCurrentHeadFromDatabase(databasePath: string, projectId: string, repositoryId: string): NativeProjectRootCurrentHead {
  const imported = readNativeProjectRootImportsFromDatabase(databasePath).find((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId);
  if (imported?.phase !== "repository-imported") throw new RepositoryRefStateError("repository has no authoritative import");
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    assertRepositoryRefTransitions(database);
    let current: NativeProjectRootCurrentHead = { projectId, repositoryId, sequence: 0, protectedRef: imported.protectedRef, commit: imported.expectedCommit, tree: imported.resolvedTree, policyDigest: imported.policyDigest };
    for (const { transition, finalized } of readRepositoryRefTransitions(database)) {
      if (transition.projectId !== projectId || transition.repositoryId !== repositoryId) continue;
      if (!finalized) throw new RepositoryRefStateError("repository ref transition recovery is pending");
      if (transition.importNonce !== imported.importNonce || transition.protectedRef !== current.protectedRef || transition.policyDigest !== current.policyDigest || transition.expectedCommit !== current.commit || transition.expectedTree !== current.tree) throw new RepositoryRefStateError("repository ref transition is not bound to the current import");
      current = head(transition);
    }
    return current;
  } finally { database.close(); }
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
