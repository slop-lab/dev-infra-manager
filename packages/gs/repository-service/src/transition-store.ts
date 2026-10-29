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
  transition_id: digestSchema,
  record_json: z.string(),
  finalized: z.union([z.literal(0), z.literal(1)]),
}).strict();

export type StoredTransition = { readonly intent: ProtectedRefIntent; readonly finalized: boolean };

export function readTransitions(database: DatabaseSync): readonly StoredTransition[] {
  return database.prepare("SELECT * FROM repository_ref_transition ORDER BY namespace_id,repository_id,sequence").all().map((raw) => {
    const row = rowSchema.parse(raw);
    const intent = parseStoredIntent(row.record_json);
    if (row.namespace_id !== intent.namespaceId || row.repository_id !== intent.repositoryId
      || row.sequence !== intent.sequence || row.transition_id !== transitionId(intent)) {
      throw new RepositoryStateError("repository journal transition identity is invalid");
    }
    return { intent, finalized: row.finalized === 1 };
  });
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
