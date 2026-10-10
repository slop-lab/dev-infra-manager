import { createHash } from "node:crypto";
import { z } from "zod";
import { descriptorDigest } from "./candidate-execution.js";
import { candidateOrdinaryExecutionDescriptorSchema } from "./candidate-execution-schema.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const prefixedDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const assignment = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const timestamp = z.string().datetime();
const output = z.object({
  bytes: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  sha256: prefixedDigest,
  truncated: z.boolean()
}).strict().readonly();
const completion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exited"), exitCode: z.number().int().min(0).max(255) }).strict().readonly(),
  z.object({ kind: z.literal("signaled"), signal: z.number().int().min(1).max(64) }).strict().readonly(),
  z.object({ kind: z.literal("timed-out") }).strict().readonly(),
  z.object({ kind: z.literal("output-limit-exceeded") }).strict().readonly(),
  z.object({ kind: z.literal("lease-lost") }).strict().readonly(),
  z.object({ kind: z.literal("cancelled") }).strict().readonly(),
  z.object({ kind: z.literal("executor-failure"), code: assignment }).strict().readonly()
]);

const terminalPayloadSchema = z.object({
    executionKind: z.literal("ordinary-sysbox"),
    reviewId: digest,
    attemptId: z.string().uuid(),
    attempt: z.number().int().positive(),
    descriptor: candidateOrdinaryExecutionDescriptorSchema,
    descriptorDigest: prefixedDigest,
    hostId: assignment,
    capacity: assignment,
    startedAt: timestamp,
    finishedAt: timestamp,
    result: z.enum(["success", "failure", "cancelled"]),
    completion,
    stdout: output,
    stderr: output
  }).strict().readonly();

export const authoritativeOrdinaryTerminalEventSchema = z.object({
  schemaVersion: z.literal(3),
  eventId: z.string().uuid(),
  occurredAt: timestamp,
  eventType: z.literal("dim.ci.job.completed"),
  payload: terminalPayloadSchema
}).strict().readonly().superRefine((event, context) => {
  if (descriptorDigest(event.payload.descriptor) !== event.payload.descriptorDigest) {
    context.addIssue({ code: "custom", message: "terminal descriptor digest is invalid",
      path: ["payload", "descriptorDigest"] });
  }
  if (Date.parse(event.payload.startedAt) > Date.parse(event.payload.finishedAt)) {
    context.addIssue({ code: "custom", message: "terminal completion precedes start", path: ["payload", "finishedAt"] });
  }
  const expectedResult = completionResult(event.payload.completion);
  if (event.payload.result !== expectedResult) {
    context.addIssue({ code: "custom", message: "terminal result is inconsistent", path: ["payload", "result"] });
  }
  if (event.payload.result === "success" && (event.payload.stdout.truncated || event.payload.stderr.truncated)) {
    context.addIssue({ code: "custom", message: "terminal success requires complete output evidence", path: ["payload"] });
  }
  if (BigInt(event.payload.stdout.bytes) + BigInt(event.payload.stderr.bytes)
    > BigInt(event.payload.descriptor.bounds.outputBytes)) {
    context.addIssue({ code: "custom", message: "terminal output exceeds descriptor bound", path: ["payload"] });
  }
});

export const authoritativeOrdinaryStatusSchema = z.object({
  schemaVersion: z.literal(3),
  eventId: z.string().uuid(),
  occurredAt: timestamp,
  eventType: z.literal("dim.ci.job.completed"),
  payload: terminalPayloadSchema,
  statusId: digest,
  reviewId: digest,
  reporterUsername: z.string().min(1),
  reportedAt: timestamp
}).strict().readonly().superRefine((status, context) => {
  const event = authoritativeOrdinaryTerminalEventSchema.safeParse({
    schemaVersion: status.schemaVersion,
    eventId: status.eventId,
    occurredAt: status.occurredAt,
    eventType: status.eventType,
    payload: status.payload
  });
  if (!event.success) {
    context.addIssue({ code: "custom", message: "ordinary terminal event is invalid", path: ["payload"] });
    return;
  }
  if (status.reviewId !== status.payload.reviewId || ordinaryStatusDigest(event.data, status.reporterUsername) !== status.statusId) {
    context.addIssue({ code: "custom", message: "ordinary status identity is invalid", path: ["statusId"] });
  }
});

export type AuthoritativeOrdinaryTerminalEvent = z.infer<typeof authoritativeOrdinaryTerminalEventSchema>;
export type AuthoritativeOrdinaryStatus = z.infer<typeof authoritativeOrdinaryStatusSchema>;

export function createAuthoritativeOrdinaryStatus(
  event: AuthoritativeOrdinaryTerminalEvent,
  reporterUsername: string,
  reportedAt: string
): AuthoritativeOrdinaryStatus {
  return authoritativeOrdinaryStatusSchema.parse({
    ...event,
    statusId: ordinaryStatusDigest(event, reporterUsername),
    reviewId: event.payload.reviewId,
    reporterUsername,
    reportedAt
  });
}

export function ordinaryTerminalEventDigest(event: AuthoritativeOrdinaryTerminalEvent): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(event)), "utf8").digest("hex")}`;
}

function ordinaryStatusDigest(event: AuthoritativeOrdinaryTerminalEvent, reporterUsername: string): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue({
    ...event,
    reviewId: event.payload.reviewId,
    reporterUsername
  })), "utf8").digest("hex");
}

function completionResult(value: z.infer<typeof completion>): "success" | "failure" | "cancelled" {
  switch (value.kind) {
    case "exited": return value.exitCode === 0 ? "success" : "failure";
    case "cancelled": return "cancelled";
    case "signaled":
    case "timed-out":
    case "output-limit-exceeded":
    case "lease-lost":
    case "executor-failure": return "failure";
    default: return assertNever(value);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected terminal completion: ${JSON.stringify(value)}`);
}
