import {
  gitCiStatusSchema,
  gitReviewSchema,
  type GitCiStatus,
  type GitReview,
} from "@slop-lab/gs-client";
import { z } from "zod";

const executionKindSchema = z.enum(["ordinary-sysbox", "qemu"]);
const dimCiJobSchema = z.object({
  name: z.string(),
  kind: executionKindSchema,
  status: z.enum(["pending", "failed", "succeeded", "stale", "unavailable"]),
  executionId: z.string().uuid().optional(),
}).strict().readonly();
const dimCiStatusSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: z.string().regex(/^[a-f0-9]{64}$/),
  candidateCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  expectedProtectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  policy: z.enum(["absent", "enabled", "unknown"]),
  state: z.enum(["not-configured", "not-required", "pending", "failed", "succeeded", "stale", "unavailable"]),
  requiredJobs: z.array(dimCiJobSchema).max(64).readonly(),
  reason: z.enum(["invalid-plan", "stale-review", "evidence-unavailable", "inspection-unavailable"]).optional(),
}).strict().readonly();

export type DimCiStatusDto = z.infer<typeof dimCiStatusSchema>;
export type ReviewDto = Omit<GitReview, "namespaceId" | "ci"> & {
  readonly projectId: string;
  readonly ci?: DimCiStatusDto;
};

export function dimCiStatusDto(input: GitCiStatus): DimCiStatusDto {
  const status = gitCiStatusSchema.parse(input);
  const { requiredChecks, ...common } = status;
  return dimCiStatusSchema.parse({
    ...common,
    requiredJobs: requiredChecks.map((check) => ({
      name: check.name,
      kind: executionKindSchema.parse(check.provider),
      status: check.status,
      ...(check.runId === undefined ? {} : { executionId: check.runId }),
    })),
  });
}

export function parseDimCiStatusDto(input: unknown): DimCiStatusDto {
  const status = dimCiStatusSchema.parse(input);
  const { requiredJobs, ...common } = status;
  dimCiStatusDto(gitCiStatusSchema.parse({
    ...common,
    requiredChecks: requiredJobs.map((job) => ({
      name: job.name,
      provider: job.kind,
      status: job.status,
      ...(job.executionId === undefined ? {} : { runId: job.executionId }),
    })),
  }));
  return status;
}

export function reviewDto(input: unknown): ReviewDto {
  const review = gitReviewSchema.parse(input);
  const { namespaceId, ci, ...rest } = review;
  return {
    ...rest,
    projectId: namespaceId,
    ...(ci === undefined ? {} : { ci: dimCiStatusDto(ci) }),
  };
}

export function parseReviewDto(input: unknown): ReviewDto {
  const row = z.record(z.string(), z.unknown()).parse(input);
  const projectId = z.string().parse(row.projectId);
  const { projectId: _projectId, ci, ...review } = row;
  const neutral = gitReviewSchema.parse({
    ...review,
    namespaceId: projectId,
    ...(ci === undefined ? {} : { ci: dimCiStatusToNeutral(ci) }),
  });
  return reviewDto(neutral);
}

function dimCiStatusToNeutral(input: unknown): GitCiStatus {
  const status = parseDimCiStatusDto(input);
  const { requiredJobs, ...common } = status;
  return gitCiStatusSchema.parse({
    ...common,
    requiredChecks: requiredJobs.map((job) => ({
      name: job.name,
      provider: job.kind,
      status: job.status,
      ...(job.executionId === undefined ? {} : { runId: job.executionId }),
    })),
  });
}
