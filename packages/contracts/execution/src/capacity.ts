import { z } from "zod";
import { executionCredentialSchema, executionIdentifierSchema } from "./config.js";
import { executionConnectionSchema } from "./connections.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const executionCapacityCostSchema = z.object({ cpu: positive, memoryBytes: positive, pids: positive }).strict();
/** Operator reservation costs include every slot and supervisor overhead, including trusted task handlers. */
export const executionCapacityProviderSchema = z.object({
  id: executionIdentifierSchema, token: executionCredentialSchema.unwrap().shape.password,
  budget: executionCapacityCostSchema,
  members: z.array(z.object({ workerId: executionIdentifierSchema, cost: executionCapacityCostSchema }).strict()).min(1).max(64),
  maximumStarting: z.number().int().min(1).max(16),
  idleMilliseconds: z.number().int().min(1_000).max(86_400_000),
  startMilliseconds: z.number().int().min(1_000).max(600_000),
  failureBackoffMilliseconds: z.number().int().min(1_000).max(300_000),
}).strict().readonly().superRefine((value, context) => {
  if (new Set(value.members.map(x => x.workerId)).size !== value.members.length || value.maximumStarting > value.members.length)
    context.addIssue({ code: "custom", message: "capacity members must be unique and starting limit must fit the pool" });
  for (const dimension of ["cpu", "memoryBytes", "pids"] as const) {
    if (value.members.reduce((sum, member) => sum + BigInt(member.cost[dimension]), 0n) > BigInt(value.budget[dimension]))
      context.addIssue({ code: "custom", message: `capacity pool exceeds its fixed ${dimension} reservation budget` });
  }
});
export type ExecutionCapacityProvider = z.infer<typeof executionCapacityProviderSchema>;
export const executionCapacityObservationSchema = z.object({ workerId: executionIdentifierSchema,
  state: z.enum(["stopped", "running", "failed"]), clean: z.boolean() }).strict();
export const executionCapacityRequestSchema = z.object({ schemaVersion: z.literal(1),
  observations: z.array(executionCapacityObservationSchema).max(64), drain: z.boolean().optional() }).strict();
export type ExecutionCapacityObservation = z.infer<typeof executionCapacityObservationSchema>;
export const executionCapacityPlanSchema = z.object({ schemaVersion: z.literal(1), generationId: z.string().regex(/^[0-9a-f]{64}$/),
  providerId: executionIdentifierSchema, workers: z.array(z.object({ workerId: executionIdentifierSchema,
    revision: z.number().int().nonnegative(), state: z.enum(["stopped", "starting", "running", "draining"]),
    action: z.enum(["start", "keep", "stop"]) }).strict()).max(64) }).strict();
export type ExecutionCapacityPlan = z.infer<typeof executionCapacityPlanSchema>;
export const executionCapacityConnectionSchema = executionConnectionSchema.extend({ role: z.literal("capacity-provider"), providerId: executionIdentifierSchema }).strict();
