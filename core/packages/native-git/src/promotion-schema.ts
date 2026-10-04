import { createHash } from "node:crypto";
import { z } from "zod";
import { descriptorDigest } from "./candidate-execution.js";
import { candidateOrdinaryExecutionDescriptorSchema } from "./candidate-execution-schema.js";

const reviewDigest = z.string().regex(/^[0-9a-f]{64}$/);
const descriptorDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const assignmentIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const canonicalBytes = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const outputEvidenceSchema = z.object({
  bytes: canonicalBytes,
  sha256: descriptorDigestSchema,
  truncated: z.boolean()
}).strict().readonly();

export const terminalCompletionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exited"), exitCode: z.number().int().min(0).max(255) }).strict().readonly(),
  z.object({ kind: z.literal("signaled"), signal: z.number().int().min(1).max(64) }).strict().readonly(),
  z.object({ kind: z.literal("timed-out") }).strict().readonly(),
  z.object({ kind: z.literal("output-limit-exceeded") }).strict().readonly(),
  z.object({ kind: z.literal("lease-lost") }).strict().readonly(),
  z.object({ kind: z.literal("cancelled") }).strict().readonly(),
  z.object({
    kind: z.literal("executor-failure"),
    code: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/)
  }).strict().readonly()
]);

type TerminalCompletion = z.infer<typeof terminalCompletionSchema>;
type TerminalResult = "success" | "failure" | "cancelled";

export const ciStatusPayloadSchema = z.object({
  reviewId: reviewDigest,
  attemptId: z.string().uuid(),
  attempt: z.number().int().positive(),
  descriptor: candidateOrdinaryExecutionDescriptorSchema,
  descriptorDigest: descriptorDigestSchema,
  hostId: assignmentIdentifier,
  capacity: assignmentIdentifier,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  result: z.enum(["success", "failure", "cancelled"]),
  completion: terminalCompletionSchema,
  stdout: outputEvidenceSchema,
  stderr: outputEvidenceSchema
}).strict().readonly().superRefine((payload, context) => {
  if (descriptorDigest(payload.descriptor) !== payload.descriptorDigest) {
    context.addIssue({ code: "custom", message: "CI descriptor digest is invalid", path: ["descriptorDigest"] });
  }
  if (Date.parse(payload.startedAt) > Date.parse(payload.finishedAt)) {
    context.addIssue({ code: "custom", message: "CI completion precedes start", path: ["finishedAt"] });
  }
  const outputBytes = BigInt(payload.stdout.bytes) + BigInt(payload.stderr.bytes);
  if (outputBytes > BigInt(payload.descriptor.bounds.outputBytes)) {
    context.addIssue({ code: "custom", message: "CI output exceeds descriptor bound", path: ["stdout"] });
  }
  if (payload.result !== completionResult(payload.completion)) {
    context.addIssue({ code: "custom", message: "CI result has inconsistent completion", path: ["result"] });
  }
});

function completionResult(completion: TerminalCompletion): TerminalResult {
  switch (completion.kind) {
    case "exited":
      return completion.exitCode === 0 ? "success" : "failure";
    case "cancelled":
      return "cancelled";
    case "signaled":
    case "timed-out":
    case "output-limit-exceeded":
    case "lease-lost":
    case "executor-failure":
      return "failure";
    default:
      return assertNever(completion);
  }
}

function assertNever(value: never): never {
  throw new CiStatusRecordError(`unexpected terminal completion: ${JSON.stringify(value)}`);
}

const ciStatusEnvelopeObjectSchema = z.object({
  schemaVersion: z.literal(2),
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  eventType: z.literal("dim.ci.job.completed"),
  payload: ciStatusPayloadSchema
}).strict();

export const ciStatusEnvelopeSchema = ciStatusEnvelopeObjectSchema.readonly();

export const ciStatusRecordSchema = ciStatusEnvelopeObjectSchema.extend({
  statusId: reviewDigest,
  reviewId: reviewDigest,
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
