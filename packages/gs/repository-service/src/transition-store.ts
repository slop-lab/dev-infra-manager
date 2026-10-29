import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ProtectedRefIntent } from "@slop-lab/gs-repository";
import {
  digestSchema,
  objectIdSchema,
  principalIdSchema,
  protectedRefSchema,
} from "./model.js";
import { RepositoryStateError } from "./state.js";

const intentSchema = z.object({
  namespaceId: z.string(),
  repositoryId: z.string(),
  sequence: z.number().int().positive(),
  protectedRef: protectedRefSchema,
  proposalRef: z.string().startsWith("refs/"),
  expectedCommit: objectIdSchema,
  expectedTree: objectIdSchema,
  candidateCommit: objectIdSchema,
  candidateTree: objectIdSchema,
  authorizationId: digestSchema,
  evidenceDigest: digestSchema,
  incarnationId: z.string().uuid(),
  authorityEpoch: digestSchema,
  policyDigest: digestSchema,
  ownerPrincipalId: principalIdSchema,
  refPolicyRevision: digestSchema,
}).strict().readonly();

const rowSchema = z.object({
  namespace_id: z.string(),
  repository_id: z.string(),
  sequence: z.number().int().positive(),
  protected_ref: protectedRefSchema,
  authorization_id: digestSchema,
  transition_id: digestSchema,
  record_json: z.string(),
  finalized: z.union([z.literal(0), z.literal(1)]),
}).strict();

export type StoredTransition = { readonly intent: ProtectedRefIntent; readonly finalized: boolean };

export function readTransitions(database: DatabaseSync, selector?: { readonly namespaceId: string; readonly repositoryId: string }): readonly StoredTransition[] {
  const rows = selector === undefined
    ? database.prepare("SELECT * FROM repository_ref_transition ORDER BY namespace_id,repository_id,sequence").all()
    : database.prepare("SELECT * FROM repository_ref_transition WHERE namespace_id=? AND repository_id=? ORDER BY sequence")
      .all(selector.namespaceId, selector.repositoryId);
  return rows.map(parseTransitionRow);
}

export function readLatestTransition(
  database: DatabaseSync,
  selector: { readonly namespaceId: string; readonly repositoryId: string },
  protectedRef?: string,
): StoredTransition | undefined {
  const row = protectedRef === undefined
    ? database.prepare("SELECT * FROM repository_ref_transition WHERE namespace_id=? AND repository_id=? ORDER BY sequence DESC LIMIT 1")
      .get(selector.namespaceId, selector.repositoryId)
    : database.prepare("SELECT * FROM repository_ref_transition WHERE namespace_id=? AND repository_id=? AND protected_ref=? AND finalized=1 ORDER BY sequence DESC LIMIT 1")
      .get(selector.namespaceId, selector.repositoryId, protectedRef);
  return row === undefined ? undefined : parseTransitionRow(row);
}

export function readTransitionById(database: DatabaseSync, id: string): StoredTransition | undefined {
  const row = database.prepare("SELECT * FROM repository_ref_transition WHERE transition_id=?").get(id);
  return row === undefined ? undefined : parseTransitionRow(row);
}

export function readPendingTransitions(database: DatabaseSync): readonly StoredTransition[] {
  return database.prepare("SELECT * FROM repository_ref_transition WHERE finalized=0 ORDER BY namespace_id,repository_id,sequence")
    .all().map(parseTransitionRow);
}

export function readFinalizedByAuthorization(
  database: DatabaseSync,
  selector: { readonly namespaceId: string; readonly repositoryId: string; readonly authorizationId: string; readonly protectedRef: string },
): readonly StoredTransition[] {
  return database.prepare("SELECT * FROM repository_ref_transition WHERE namespace_id=? AND repository_id=? AND authorization_id=? AND protected_ref=? AND finalized=1 ORDER BY sequence")
    .all(selector.namespaceId, selector.repositoryId, selector.authorizationId, selector.protectedRef)
    .map(parseTransitionRow);
}

function parseTransitionRow(raw: unknown): StoredTransition {
  const row = rowSchema.parse(raw);
  const intent = parseStoredIntent(row.record_json);
  if (row.namespace_id !== intent.namespaceId || row.repository_id !== intent.repositoryId
    || row.sequence !== intent.sequence || row.protected_ref !== intent.protectedRef
    || row.authorization_id !== intent.authorizationId || row.transition_id !== transitionId(intent)) {
    throw new RepositoryStateError("repository journal transition identity is invalid");
  }
  return { intent, finalized: row.finalized === 1 };
}

export function transitionId(intent: ProtectedRefIntent): string {
  return createHash("sha256").update("gs-repository-ref-v1\0").update(JSON.stringify(intentSchema.parse(intent))).digest("hex");
}

function parseStoredIntent(record: string): ProtectedRefIntent {
  try {
    const parsed: unknown = JSON.parse(record);
    return intentSchema.parse(parsed);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RepositoryStateError("repository journal transition is invalid");
    }
    throw error;
  }
}
