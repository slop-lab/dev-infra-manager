import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ScheduledAssignment } from "./types.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const taskIdentifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const descriptorDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const boundedJson = z.json().refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, "task value exceeds 1 MiB");
export const taskEventSchema = z.object({ eventId: z.string().uuid(), executionKind: z.string().regex(/^task\/[a-z0-9][a-z0-9-]{0,63}$/),
  taskType: taskIdentifier, handlerRevision: revision, payload: boundedJson }).strict().readonly().refine((event) => event.executionKind === `task/${event.taskType}`, "task kind differs from its type");
export type TaskEvent = z.infer<typeof taskEventSchema>;
export const taskProfileSchema = z.object({ taskType: taskIdentifier, handlerRevision: revision }).strict().readonly();
export type TaskProfile = z.infer<typeof taskProfileSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("task descriptor contains a non-JSON value");
  return encoded;
}
export function taskDescriptorDigest(event: TaskEvent, profile: TaskProfile): string {
  return `sha256:${createHash("sha256").update(canonical({ event: taskEventSchema.parse(event), profile: taskProfileSchema.parse(profile) })).digest("hex")}`;
}
export const taskGrantSchema = z.object({ executionId: z.string().uuid(), generationId: revision,
  workerId: identifier, slotId: identifier, event: taskEventSchema, profile: taskProfileSchema, descriptorDigest }).strict().readonly().superRefine((grant, context) => {
  if (grant.profile.taskType !== grant.event.taskType || grant.profile.handlerRevision !== grant.event.handlerRevision || grant.descriptorDigest !== taskDescriptorDigest(grant.event, grant.profile)) context.addIssue({ code: "custom", message: "task grant does not match its input and handler" });
});
export type TaskGrant = z.infer<typeof taskGrantSchema>;
export const taskResultSchema = z.object({ executionId: z.string().uuid(), descriptorDigest, cleanupComplete: z.literal(true),
  result: z.enum(["success", "failure", "cancelled"]), value: boundedJson.optional(), error: z.string().max(2048).optional() }).strict().readonly();
export type TaskResult = z.infer<typeof taskResultSchema>;
export const taskJobSchema = z.object({ id: z.string().uuid(), event: taskEventSchema,
  phase: z.enum(["queued", "assigned", "running", "recovering", "finished"]), generationId: revision,
  createdAt: z.number().int().nonnegative(), workerId: identifier.optional(), slotId: identifier.optional(),
  requestId: z.string().uuid().optional(), leaseToken: z.string().min(32).max(128).optional(),
  leaseExpiresAt: z.number().int().positive().optional(), profile: taskProfileSchema.optional(), grant: taskGrantSchema.optional(), result: taskResultSchema.optional(),
  retryOf: z.string().uuid().optional(), retryRequestId: z.string().uuid().optional(), cancelRequestedAt: z.number().int().nonnegative().optional(),
  publication: z.enum(["pending", "accepted", "stale"]) }).strict().superRefine((job, context) => {
  const ownership = [job.workerId, job.slotId, job.requestId, job.leaseToken, job.leaseExpiresAt, job.profile];
  const abandoned = job.phase === "finished" && job.publication === "stale" && ownership.every((value) => value === undefined) && job.grant === undefined && job.result === undefined;
  const invalidOwnership = job.phase === "queued" ? ownership.some((value) => value !== undefined) || job.grant !== undefined || job.result !== undefined || job.publication !== "pending" : ownership.some((value) => value === undefined) && !abandoned;
  if (invalidOwnership || (job.retryOf === undefined) !== (job.retryRequestId === undefined) || job.retryOf === job.id
    || job.cancelRequestedAt !== undefined && !["recovering", "finished"].includes(job.phase)
    || job.phase !== "finished" && (job.result !== undefined || job.publication !== "pending")
    || job.phase === "finished" && job.result === undefined && job.publication !== "stale"
    || job.phase === "running" && job.grant === undefined
    || job.profile !== undefined && (job.profile.taskType !== job.event.taskType || job.profile.handlerRevision !== job.event.handlerRevision)
    || job.grant !== undefined && (job.grant.executionId !== job.id || job.grant.generationId !== job.generationId || job.grant.workerId !== job.workerId || job.grant.slotId !== job.slotId || !isDeepStrictEqual(job.grant.event, job.event) || !isDeepStrictEqual(job.grant.profile, job.profile))
    || job.result !== undefined && (job.result.executionId !== job.id || job.result.descriptorDigest !== job.grant?.descriptorDigest)) context.addIssue({ code: "custom", message: "task execution state is inconsistent" });
});
export type TaskExecution = z.infer<typeof taskJobSchema>;
export type TaskAssignment = ScheduledAssignment<TaskEvent, TaskProfile, TaskGrant, TaskResult>;
export function isTaskExecution<T extends { readonly event: { readonly executionKind: string } }>(job: T): job is T & TaskExecution { return job.event.executionKind.startsWith("task/"); }
