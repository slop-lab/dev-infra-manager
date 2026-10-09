import { DatabaseSync } from "node:sqlite";
import {
  NativeProjectRootPromotionStateError,
  parseNativeProjectRootPromotionRow,
  type NativeProjectRootPromotionTransition
} from "./native-project-root-promotion-codec.js";
import type { NativeProjectRootImport, NativeProjectRootImportInstalled } from "./native-project-root-import-codec.js";
import { assertNativeProjectRootImportRows } from "./native-project-root-import-state.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import type { NativeImportedRootPolicy } from "./native-imported-root-policy.js";

type AuthoritativeNativeProjectRootImport = NativeProjectRootImportInstalled & {
  readonly policyFormat: "authoritative-v1";
  readonly policy: NativeImportedRootPolicy;
};

const transitionColumns = `project_id, transition_id, import_nonce, sequence, review_id, protected_ref,
  proposal_ref, expected_commit, expected_tree, candidate_commit, candidate_tree, decision_generation,
  policy_sha256, policy_revision, required_review_revision, required_job_set_revision,
  evidence_json, evidence_sha256`;
const transitionSchemaColumns = `
  project_id TEXT NOT NULL REFERENCES native_project_root_import(project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  transition_id TEXT NOT NULL UNIQUE
    CHECK (length(transition_id) = 64 AND transition_id NOT GLOB '*[^0-9a-f]*'),
  import_nonce TEXT NOT NULL REFERENCES native_project_root_import(import_nonce) ON UPDATE RESTRICT ON DELETE RESTRICT
    CHECK (length(import_nonce) = 36),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  review_id TEXT NOT NULL CHECK (length(review_id) = 64 AND review_id NOT GLOB '*[^0-9a-f]*'),
  protected_ref TEXT NOT NULL CHECK (length(protected_ref) BETWEEN 1 AND 1024),
  proposal_ref TEXT NOT NULL CHECK (length(proposal_ref) BETWEEN 1 AND 1024),
  expected_commit TEXT NOT NULL
    CHECK ((length(expected_commit) = 40 OR length(expected_commit) = 64)
      AND expected_commit NOT GLOB '*[^0-9a-f]*'),
  expected_tree TEXT NOT NULL
    CHECK ((length(expected_tree) = 40 OR length(expected_tree) = 64)
      AND expected_tree NOT GLOB '*[^0-9a-f]*'),
  candidate_commit TEXT NOT NULL
    CHECK ((length(candidate_commit) = 40 OR length(candidate_commit) = 64)
      AND candidate_commit NOT GLOB '*[^0-9a-f]*'),
  candidate_tree TEXT NOT NULL
    CHECK ((length(candidate_tree) = 40 OR length(candidate_tree) = 64)
      AND candidate_tree NOT GLOB '*[^0-9a-f]*'),
  decision_generation TEXT NOT NULL REFERENCES bundle_activation(generation_id) ON UPDATE RESTRICT ON DELETE RESTRICT
    CHECK (length(decision_generation) = 64 AND decision_generation NOT GLOB '*[^0-9a-f]*'),
  policy_sha256 TEXT NOT NULL
    CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_revision TEXT NOT NULL
    CHECK (length(policy_revision) = 64 AND policy_revision NOT GLOB '*[^0-9a-f]*'),
  required_review_revision TEXT NOT NULL
    CHECK (length(required_review_revision) = 64 AND required_review_revision NOT GLOB '*[^0-9a-f]*'),
  required_job_set_revision TEXT NOT NULL
    CHECK (length(required_job_set_revision) = 64 AND required_job_set_revision NOT GLOB '*[^0-9a-f]*'),
  evidence_json TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL
    CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')`;

export const nativeProjectRootPromotionIntentSchema = `CREATE TABLE native_project_root_promotion_intent (${transitionSchemaColumns},
  PRIMARY KEY (project_id)
) STRICT`;

export const nativeProjectRootPromotionFinalizedSchema = `CREATE TABLE native_project_root_promotion_finalized (${transitionSchemaColumns},
  PRIMARY KEY (project_id, sequence),
  UNIQUE (project_id, review_id)
) STRICT`;

export type NativeProjectRootCurrentHead = {
  readonly projectId: string;
  readonly sequence: number;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
  readonly policyDigest: string;
};

export function assertNativeProjectRootPromotionRows(database: DatabaseSync): void {
  const imports = new Map(assertNativeProjectRootImportRows(database).map((entry) => [entry.projectId, entry]));
  const generations = activatedGenerations(database);
  const finalized = selectTransitions(database, "native_project_root_promotion_finalized");
  const byProject = new Map<string, NativeProjectRootPromotionTransition[]>();
  for (const transition of finalized) {
    const projectTransitions = byProject.get(transition.projectId) ?? [];
    projectTransitions.push(transition);
    byProject.set(transition.projectId, projectTransitions);
  }
  const heads = new Map<string, NativeProjectRootCurrentHead>();
  for (const [projectId, transitions] of byProject) {
    heads.set(projectId, foldCurrentHead(requirePromotableImport(imports.get(projectId)), transitions, generations));
  }
  const intents = selectTransitions(database, "native_project_root_promotion_intent");
  for (const intent of intents) {
    const imported = requirePromotableImport(imports.get(intent.projectId));
    const current = heads.get(intent.projectId) ?? initialHead(imported);
    assertNextTransition(imported, current, intent, generations);
  }
  if (finalized.length > 0 || intents.length > 0) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion evidence is not yet verified");
  }
}

export function readNativeProjectRootCurrentHeadFromDatabase(
  databasePath: string,
  projectId: string
): NativeProjectRootCurrentHead {
  const imported = requirePromotableImport(readNativeProjectRootImportsFromDatabase(databasePath)
    .find((entry) => entry.projectId === projectId));
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    const generations = activatedGenerations(database);
    const intents = selectTransitions(database, "native_project_root_promotion_intent", projectId);
    const finalized = selectTransitions(database, "native_project_root_promotion_finalized", projectId);
    const current = foldCurrentHead(imported, finalized, generations);
    for (const intent of intents) {
      assertNextTransition(imported, current, intent, generations);
      throw new NativeProjectRootPromotionStateError("native Project root promotion intent is unresolved");
    }
    if (finalized.length > 0) {
      throw new NativeProjectRootPromotionStateError("native Project root promotion evidence is not yet verified");
    }
    return current;
  } finally {
    database.close();
  }
}

function foldCurrentHead(
  imported: AuthoritativeNativeProjectRootImport,
  transitions: readonly NativeProjectRootPromotionTransition[],
  generations: ReadonlySet<string>
): NativeProjectRootCurrentHead {
  let current = initialHead(imported);
  for (const transition of transitions) {
    assertNextTransition(imported, current, transition, generations);
    current = { ...current, sequence: transition.sequence, commit: transition.candidateCommit,
      tree: transition.candidateTree };
  }
  return current;
}

function assertNextTransition(
  imported: AuthoritativeNativeProjectRootImport,
  current: NativeProjectRootCurrentHead,
  transition: NativeProjectRootPromotionTransition,
  generations: ReadonlySet<string>
): void {
  const policy = imported.policy;
  const expectedJobs = policy.requiredJobs.map(({ name, kind, evidenceClass }) => ({
    executionKind: kind, jobName: name, evidenceClass
  })).sort((left, right) => left.executionKind.localeCompare(right.executionKind)
    || left.jobName.localeCompare(right.jobName));
  const actualJobs = transition.evidence.jobs.map(({ evidenceDigest: _evidenceDigest, ...job }) => job);
  if (transition.projectId !== imported.projectId || transition.importNonce !== imported.importNonce
    || transition.sequence !== current.sequence + 1 || transition.expectedCommit !== current.commit
    || transition.expectedTree !== current.tree || transition.protectedRef !== imported.protectedRef
    || transition.policyDigest !== imported.policyDigest || transition.policyRevision !== policy.policyRevision
    || transition.requiredReviewRevision !== policy.requiredReviewRevision
    || transition.requiredJobSetRevision !== policy.requiredJobSetRevision
    || !generations.has(transition.decisionGeneration)
    || JSON.stringify(actualJobs) !== JSON.stringify(expectedJobs)
    || policy.requiredReviewerIds.some((reviewer) => !transition.evidence.requiredReviewerIds.includes(reviewer))) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion chain is invalid");
  }
}

function initialHead(imported: AuthoritativeNativeProjectRootImport): NativeProjectRootCurrentHead {
  if (imported.expectedCommit.length !== imported.resolvedTree.length) {
    throw new NativeProjectRootPromotionStateError("native Project imported root object formats conflict");
  }
  return { projectId: imported.projectId, sequence: 0, protectedRef: imported.protectedRef,
    commit: imported.expectedCommit, tree: imported.resolvedTree, policyDigest: imported.policyDigest };
}

function requirePromotableImport(
  imported: NativeProjectRootImport | undefined
): AuthoritativeNativeProjectRootImport {
  if (imported === undefined || imported.phase !== "root-imported" || imported.policyFormat !== "authoritative-v1") {
    throw new NativeProjectRootPromotionStateError("native Project root promotion requires an authoritative import");
  }
  return imported;
}

function selectTransitions(
  database: DatabaseSync,
  table: "native_project_root_promotion_finalized" | "native_project_root_promotion_intent",
  projectId?: string
): readonly NativeProjectRootPromotionTransition[] {
  const where = projectId === undefined ? "" : " WHERE project_id = ?";
  return database.prepare(`SELECT ${transitionColumns} FROM ${table}${where} ORDER BY project_id, sequence`)
    .all(...(projectId === undefined ? [] : [projectId])).map(parseNativeProjectRootPromotionRow);
}

function activatedGenerations(database: DatabaseSync): ReadonlySet<string> {
  const generations = new Set<string>();
  for (const row of database.prepare("SELECT generation_id FROM bundle_activation").all()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const generation = Reflect.get(row, "generation_id");
    if (typeof generation === "string") generations.add(generation);
  }
  return generations;
}

export { NativeProjectRootPromotionStateError } from "./native-project-root-promotion-codec.js";
