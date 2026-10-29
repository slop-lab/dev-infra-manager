import { z } from "zod";
import {
  reviewCiStatusSchema,
  type ReviewCiStatus,
} from "@slop-lab/gs-ci-contracts";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const dimReviewCiJobSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  kind: z.enum(["ordinary-sysbox", "qemu"]),
  status: z.enum(["pending", "failed", "succeeded", "stale", "unavailable"]),
  executionId: z.string().uuid().optional(),
}).strict().readonly();

export const dimReviewCiStatusSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  candidateCommit: objectId,
  expectedProtectedHead: objectId,
  policy: z.enum(["absent", "enabled", "unknown"]),
  state: z.enum(["not-configured", "not-required", "pending", "failed", "succeeded", "stale", "unavailable"]),
  requiredJobs: z.array(dimReviewCiJobSchema).max(64).readonly(),
  reason: z.enum(["invalid-plan", "stale-review", "evidence-unavailable", "inspection-unavailable"]).optional(),
}).strict().superRefine((status, context) => {
  if (status.state === "succeeded" && (status.policy !== "enabled" || status.requiredJobs.length === 0
    || status.requiredJobs.some((job) => job.status !== "succeeded"))) {
    context.addIssue({ code: "custom", message: "successful CI requires successful evidence for every required job" });
  }
  if ((status.state === "not-configured" && (status.policy !== "absent" || status.requiredJobs.length !== 0))
    || (status.state === "not-required" && (status.policy !== "enabled" || status.requiredJobs.length !== 0))) {
    context.addIssue({ code: "custom", message: "CI requirement state conflicts with policy" });
  }
}).readonly();

export type DimReviewCiJob = z.infer<typeof dimReviewCiJobSchema>;
export type DimReviewCiStatus = z.infer<typeof dimReviewCiStatusSchema>;

export function encodeDimReviewCiStatus(status: ReviewCiStatus, generationId: string): DimReviewCiStatus {
  const { requiredChecks, ...fields } = status;
  return dimReviewCiStatusSchema.parse({
    ...fields,
    generationId,
    requiredJobs: requiredChecks.map(({ name, provider, status: checkStatus, runId }) => ({
      name,
      kind: provider,
      status: checkStatus,
      ...(runId === undefined ? {} : { executionId: runId }),
    })),
  });
}

export function decodeDimReviewCiStatus(input: unknown): ReviewCiStatus {
  const status = dimReviewCiStatusSchema.parse(input);
  return reviewCiStatusSchema.parse({
    schemaVersion: 1,
    reviewId: status.reviewId,
    candidateCommit: status.candidateCommit,
    expectedProtectedHead: status.expectedProtectedHead,
    policy: status.policy,
    state: status.state,
    requiredChecks: status.requiredJobs.map(({ name, kind, status: checkStatus, executionId }) => ({
      name,
      provider: kind,
      status: checkStatus,
      ...(executionId === undefined ? {} : { runId: executionId }),
    })),
    ...(status.reason === undefined ? {} : { reason: status.reason }),
  });
}
