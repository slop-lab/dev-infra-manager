import { z } from "zod";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const reviewCiJobSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  kind: z.enum(["ordinary-sysbox", "qemu"]),
  status: z.enum(["pending", "failed", "succeeded", "stale", "unavailable"]),
  executionId: z.string().uuid().optional()
}).strict().readonly();
export const reviewCiStatusSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  candidateCommit: objectId,
  expectedProtectedHead: objectId,
  policy: z.enum(["absent", "enabled", "unknown"]),
  state: z.enum(["not-configured", "not-required", "pending", "failed", "succeeded", "stale", "unavailable"]),
  requiredJobs: z.array(reviewCiJobSchema).max(64).readonly(),
  reason: z.enum(["invalid-plan", "stale-review", "evidence-unavailable", "inspection-unavailable"]).optional()
}).strict().superRefine((status, context) => {
  if (status.state === "succeeded" && (status.policy !== "enabled" || status.requiredJobs.length === 0
    || status.requiredJobs.some((job) => job.status !== "succeeded"))) {
    context.addIssue({ code: "custom", message: "successful DIM CI requires successful evidence for every required job" });
  }
  if ((status.state === "not-configured" && (status.policy !== "absent" || status.requiredJobs.length !== 0))
    || (status.state === "not-required" && (status.policy !== "enabled" || status.requiredJobs.length !== 0))) {
    context.addIssue({ code: "custom", message: "DIM CI requirement state conflicts with policy" });
  }
}).readonly();
export type ReviewCiJob = z.infer<typeof reviewCiJobSchema>;
export type ReviewCiStatus = z.infer<typeof reviewCiStatusSchema>;
