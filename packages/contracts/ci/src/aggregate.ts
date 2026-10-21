import type { ExecutionEvent, ExecutionGrant, ExecutionProfile } from "./execution-protocol.js";
export type { ExecutionEvent, ExecutionGrant, ExecutionProfile };
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export type ExecutionPhase = "queued" | "assigned" | "running" | "recovering" | "finished";
export type Execution = z.infer<typeof executionSchema>;
export type ExecutionAssignment = Execution & { readonly workerId: string; readonly slotId: string;
  readonly requestId: string; readonly leaseToken: string; readonly leaseExpiresAt: number;
  readonly profile: ExecutionProfile };
export type WorkerSlot = { readonly id: string; readonly kind: ExecutionEvent["executionKind"]; readonly profile: ExecutionProfile };
export type WorkerIdentity = { readonly id: string; readonly token: string; readonly slots: readonly WorkerSlot[] };
export { ExecutionConflictError } from "@slop-lab/dim-task-scheduling/types";

import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { executionEventSchema, executionGrantSchema, executionProfileSchema, executionResultSchema as gitExecutionResultSchema } from "./execution-protocol.js";
const diagnostic = z.object({ base64: z.string().max(88_000).refine((value) =>
  Buffer.from(value, "base64").toString("base64") === value && Buffer.from(value, "base64").length <= 64 * 1024),
  truncated: z.boolean() }).strict();
export const executionResultSchema = gitExecutionResultSchema.unwrap().extend({
  logs: z.object({ stdout: diagnostic, stderr: diagnostic }).strict()
}).strict().superRefine((result, context) => {
  const { logs, ...evidence } = result;
  const parsed = gitExecutionResultSchema.safeParse(evidence);
  if (!parsed.success) context.addIssue({ code: "custom", message: "execution result metadata is inconsistent" });
  for (const stream of ["stdout", "stderr"] as const) {
    if (!/^[0-9]+$/.test(result[stream].bytes)) continue;
    const length = Buffer.from(logs[stream].base64, "base64").length;
    if (logs[stream].truncated ? BigInt(result[stream].bytes) <= BigInt(length) : BigInt(result[stream].bytes) !== BigInt(length)) {
      context.addIssue({ code: "custom", message: "execution diagnostic length is inconsistent" });
    }
  }
});
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const executionSchema = z.object({ id: z.string().uuid(), event: executionEventSchema,
  phase: z.enum(["queued", "assigned", "running", "recovering", "finished"]),
  generationId: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.number().int().nonnegative(),
  workerId: id.optional(), slotId: id.optional(), requestId: z.string().uuid().optional(),
  leaseToken: z.string().min(32).max(128).optional(), leaseExpiresAt: z.number().int().positive().optional(),
  profile: executionProfileSchema.optional(), grant: executionGrantSchema.optional(), result: executionResultSchema.optional(),
  retryOf: z.string().uuid().optional(), retryRequestId: z.string().uuid().optional(),
  cancelRequestedAt: z.number().int().nonnegative().optional(),
  publication: z.enum(["pending", "accepted", "stale"])
}).strict().superRefine((job, context) => {
  if ((job.retryOf === undefined) !== (job.retryRequestId === undefined) || job.retryOf === job.id
    || job.cancelRequestedAt !== undefined && !["recovering", "finished"].includes(job.phase)) {
    context.addIssue({ code: "custom", message: "execution operator metadata is inconsistent" });
  }
  const ownership = [job.workerId, job.slotId, job.requestId, job.leaseToken, job.leaseExpiresAt, job.profile];
  const queued = job.phase === "queued";
  let invalid = queued ? ownership.some((value) => value !== undefined) || job.grant !== undefined || job.result !== undefined
    || job.publication !== "pending" : ownership.some((value) => value === undefined)
      && !(job.phase === "finished" && job.publication === "stale" && ownership.every((value) => value === undefined)
        && job.grant === undefined && job.result === undefined);
  if (job.phase !== "finished" && (job.result !== undefined || job.publication !== "pending")) invalid = true;
  if (job.phase === "finished" && job.result === undefined && job.publication !== "stale") invalid = true;
  if (job.phase === "running" && job.grant === undefined) invalid = true;
  if (job.grant !== undefined && (job.grant.executionId !== job.id || job.grant.generationId !== job.generationId
    || job.grant.workerId !== job.workerId || job.grant.slotId !== job.slotId
    || !isDeepStrictEqual(job.grant.event, job.event) || !isDeepStrictEqual(job.grant.profile, job.profile))) invalid = true;
  if (job.result !== undefined && (job.result.executionId !== job.id || job.result.descriptorDigest !== job.grant?.descriptorDigest)) invalid = true;
  if (invalid) context.addIssue({ code: "custom", message: "execution state is inconsistent" });
});
export function parseExecution(value: unknown): Execution { return executionSchema.parse(value); }
