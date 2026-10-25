import { z } from "zod";
import { currentRevision, parsePullRequest, pullRequestSchema, type PullRequest } from "@slop-lab/git-pull-requests";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import type { NativeGitClient } from "./client.js";
import { parseReviewDto, type ReviewDto } from "./dto.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const pullRequestWorkflowInputSchema = z.object({ projectId: identifier, repositoryId: identifier,
  pullRequestId: z.string().uuid(), expectedVersion: z.number().int().positive(), revisionId: z.string().uuid() }).strict().readonly();
type WorkflowInput = z.infer<typeof pullRequestWorkflowInputSchema>;
const promotionSchema = z.object({ schemaVersion: z.literal(1), outcome: z.enum(["promoted", "already-current"]),
  reviewId: z.string(), protectedRef: z.string(), expectedProtectedHead: z.string(), candidateCommit: z.string(), candidateTree: z.string() }).strict();
function parseMerged(value: unknown) {
  const result = z.object({ pullRequest: pullRequestSchema, review: z.unknown(), promotion: promotionSchema, refreshPending: z.boolean() }).strict().parse(value);
  return { ...result, review: parseReviewDto(result.review) };
}
export const pullRequestWorkflowOperations: readonly Operation[] = [
  { name: "pull-requests.approve", description: "Approve the exact selected pull request revision", access: "reviewer", parseInput: (value) => pullRequestWorkflowInputSchema.parse(value), parseOutput: parseReviewDto },
  { name: "pull-requests.revoke", description: "Revoke this reviewer's approval of the selected revision", access: "reviewer", parseInput: (value) => pullRequestWorkflowInputSchema.parse(value), parseOutput: parseReviewDto },
  { name: "pull-requests.merge", description: "Promote the exact revision through human and DIM CI policy without approving it", access: "operator", parseInput: (value) => pullRequestWorkflowInputSchema.parse(value), parseOutput: parseMerged }
];

export function isPullRequestWorkflow(name: string): boolean {
  return pullRequestWorkflowOperations.some((operation) => operation.name === name);
}
export async function invokePullRequestWorkflow(client: NativeGitClient, action: { readonly name: string; readonly input: WorkflowInput; readonly reviewerId: string }): Promise<unknown> {
  const { input, name, reviewerId } = action;
  const scope = { projectId: input.projectId, repositoryId: input.repositoryId };
  const read = async () => parsePullRequest(await client.invokeRepositoryFeature("pull-requests.detail", { ...scope, pullRequestId: input.pullRequestId }));
  const record = await read();
  assertSelected(record, input);
  const prepared = z.object({ pullRequestId: z.string().uuid(), revisionId: z.string().uuid(),
    review: z.object({ review: z.object({ reviewId: z.string().regex(/^[0-9a-f]{64}$/) }).passthrough() }).passthrough() }).strict()
    .parse(await client.invokeRepositoryFeature("pull-requests.review", { ...scope, pullRequestId: record.id, expectedVersion: record.version }));
  if (prepared.pullRequestId !== record.id || prepared.revisionId !== input.revisionId) stale();
  const review = await client.getReview(input.projectId, input.repositoryId, prepared.review.review.reviewId);
  assertReview(record, review, scope);
  assertSelected(await read(), input);
  switch (name) {
    case "pull-requests.approve": return client.approveReview(input.projectId, input.repositoryId, review.reviewId);
    case "pull-requests.revoke": {
      const approval = review.approvals.find((entry) => entry.reviewerId === reviewerId
        && !review.revocations.some((revocation) => revocation.approvalId === entry.approvalId));
      if (!approval) throw new PullRequestWorkflowError("approval-missing", "This reviewer has no active approval for this exact revision");
      return client.revokeApproval(input.projectId, input.repositoryId, review.reviewId, approval.approvalId);
    }
    case "pull-requests.merge": {
      if (review.status !== "approved") throw new PullRequestWorkflowError("approval-required", "The exact revision still requires human approval");
      if (!review.ci || !["not-configured", "not-required", "succeeded"].includes(review.ci.state)) {
        throw new PullRequestWorkflowError("ci-required", "Required DIM CI is not successful; inspect the current review's CI evidence before merging");
      }
      const promotion = await client.promote(input.projectId, input.repositoryId, review.reviewId);
      try {
        const refreshed = parsePullRequest(await client.invokeRepositoryFeature("pull-requests.refresh", { ...scope, pullRequestId: record.id, expectedVersion: record.version }));
        return { pullRequest: refreshed, review, promotion, refreshPending: false };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { pullRequest: record, review, promotion, refreshPending: true };
      }
    }
    default: throw new PullRequestWorkflowError("unavailable", "Pull request workflow operation is unavailable");
  }
}
function assertSelected(record: PullRequest, input: WorkflowInput): void {
  if (record.state !== "open" || record.id !== input.pullRequestId || record.version !== input.expectedVersion
    || currentRevision(record).id !== input.revisionId) stale();
}
function assertReview(record: PullRequest, review: ReviewDto, scope: { readonly projectId: string; readonly repositoryId: string }): void {
  const revision = currentRevision(record);
  if (review.projectId !== scope.projectId || review.repositoryId !== scope.repositoryId
    || review.status === "stale" || review.staleReasons.length !== 0 || review.proposalRef !== record.sourceRef
    || review.protectedRef !== record.targetRef || review.candidateCommit !== revision.sourceCommit
    || review.expectedProtectedHead !== revision.targetCommit) stale();
}
function stale(): never { throw new PullRequestWorkflowError("stale", "Pull request revision changed; refresh and inspect it before taking a decision"); }
export class PullRequestWorkflowError extends Error {
  constructor(readonly code: "stale" | "approval-missing" | "approval-required" | "ci-required" | "unavailable", message: string) { super(message); }
}
