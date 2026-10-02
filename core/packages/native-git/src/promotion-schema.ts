import { createHash } from "node:crypto";
import { z } from "zod";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

export const ciStatusPayloadSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  protectedRef: z.string().min(1).max(1024),
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: z.string().min(1),
  requiredReviewRevision: z.string().min(1),
  requiredJobSetRevision: z.string().min(1),
  jobName: identifier,
  attempt: z.number().int().positive(),
  attemptId: z.string().uuid(),
  result: z.enum(["success", "failure", "cancelled"])
}).strict().readonly();

const ciStatusEnvelopeObjectSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  eventType: z.literal("dim.ci.job.completed"),
  payload: ciStatusPayloadSchema
}).strict();

export const ciStatusEnvelopeSchema = ciStatusEnvelopeObjectSchema.readonly();

export const ciStatusRecordSchema = ciStatusEnvelopeObjectSchema.extend({
  statusId: digest,
  reviewId: digest,
  reporterUsername: z.string(),
  reportedAt: z.string().datetime()
}).strict().readonly();

export type CiStatusEnvelope = z.infer<typeof ciStatusEnvelopeSchema>;
export type CiStatusRecord = z.infer<typeof ciStatusRecordSchema>;

export function statusDigest(record: Omit<CiStatusRecord, "statusId" | "reportedAt">): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(record)), "utf8").digest("hex");
}

export function parseCiStatusRecord(input: unknown): CiStatusRecord {
  const status = ciStatusRecordSchema.parse(input);
  const { statusId, reportedAt: _reportedAt, ...identity } = status;
  if (statusDigest(identity) !== statusId) throw new CiStatusRecordError("stored CI status digest is invalid");
  return status;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(Reflect.get(value, key));
  return canonical;
}

export class CiStatusRecordError extends Error {
  readonly name = "CiStatusRecordError";
}
