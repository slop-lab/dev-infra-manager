import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const reviewCiCheckSchema = z.object({
  name: identifier,
  provider: identifier,
  status: z.enum(["pending", "failed", "succeeded", "stale", "unavailable"]),
  runId: z.string().min(1).max(256).optional(),
}).strict().readonly();

export const reviewCiStatusSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  candidateCommit: objectId,
  expectedProtectedHead: objectId,
  policy: z.enum(["absent", "enabled", "unknown"]),
  state: z.enum(["not-configured", "not-required", "pending", "failed", "succeeded", "stale", "unavailable"]),
  requiredChecks: z.array(reviewCiCheckSchema).max(64).readonly(),
  reason: z.enum(["invalid-plan", "stale-review", "evidence-unavailable", "inspection-unavailable"]).optional(),
}).strict().superRefine((status, context) => {
  if (status.state === "succeeded" && (status.policy !== "enabled" || status.requiredChecks.length === 0
    || status.requiredChecks.some((check) => check.status !== "succeeded"))) {
    context.addIssue({ code: "custom", message: "successful CI requires successful evidence for every required check" });
  }
  if ((status.state === "not-configured" && (status.policy !== "absent" || status.requiredChecks.length !== 0))
    || (status.state === "not-required" && (status.policy !== "enabled" || status.requiredChecks.length !== 0))) {
    context.addIssue({ code: "custom", message: "CI requirement state conflicts with policy" });
  }
}).readonly();

export type ReviewCiCheck = z.infer<typeof reviewCiCheckSchema>;
export type ReviewCiStatus = z.infer<typeof reviewCiStatusSchema>;
