import { currentRevision, parsePullRequest, type PullRequest } from "@slop-lab/gs-pull-requests";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type { GitReview, PreparedPullRequestReview, PromotionReceipt } from "./schemas.js";
import type { PullRequestSelection } from "./transport.js";

export type PullRequestWorkflowInput = PullRequestSelection & {
  readonly revisionId: string;
};

export interface PullRequestWorkflowPort {
  readPullRequest(selector: RepositorySelector, pullRequestId: string): Promise<PullRequest>;
  preparePullRequestReview(selection: PullRequestSelection): Promise<PreparedPullRequestReview>;
  readReview(selector: RepositorySelector, reviewId: string): Promise<GitReview>;
  approveReview(selector: RepositorySelector, reviewId: string): Promise<GitReview>;
  revokeReview(selector: RepositorySelector, reviewId: string, approvalId: string): Promise<GitReview>;
  promoteReview(selector: RepositorySelector, reviewId: string): Promise<PromotionReceipt>;
  refreshPullRequest(selection: PullRequestSelection): Promise<PullRequest>;
}

export async function approveSelectedPullRequest(port: PullRequestWorkflowPort, input: PullRequestWorkflowInput): Promise<GitReview> {
  const selected = await prepareSelectedReview(port, input);
  return port.approveReview(input, selected.review.reviewId);
}

export async function revokeSelectedPullRequest(port: PullRequestWorkflowPort, input: PullRequestWorkflowInput, reviewerId: string): Promise<GitReview> {
  const selected = await prepareSelectedReview(port, input);
  const approval = selected.review.approvals.find((entry) => entry.reviewerId === reviewerId
    && !selected.review.revocations.some((revocation) => revocation.approvalId === entry.approvalId));
  if (approval === undefined) throw new PullRequestWorkflowError("approval-missing", "This reviewer has no active approval for this exact revision");
  return port.revokeReview(input, selected.review.reviewId, approval.approvalId);
}

export async function mergeSelectedPullRequest(port: PullRequestWorkflowPort, input: PullRequestWorkflowInput): Promise<{
  readonly pullRequest: PullRequest;
  readonly review: GitReview;
  readonly promotion: PromotionReceipt;
  readonly refreshPending: boolean;
}> {
  const selected = await prepareSelectedReview(port, input);
  if (selected.review.status !== "approved") throw new PullRequestWorkflowError("approval-required", "The exact revision still requires human approval");
  if (selected.review.ci === undefined || !["not-configured", "not-required", "succeeded"].includes(selected.review.ci.state)) {
    throw new PullRequestWorkflowError("ci-required", "Required Git CI is not successful; inspect the current review's CI evidence before merging");
  }
  const promotion = await port.promoteReview(input, selected.review.reviewId);
  try {
    const pullRequest = await port.refreshPullRequest({ ...input, pullRequestId: selected.pullRequest.id, expectedVersion: selected.pullRequest.version });
    return { pullRequest, review: selected.review, promotion, refreshPending: false };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { pullRequest: selected.pullRequest, review: selected.review, promotion, refreshPending: true };
  }
}

async function prepareSelectedReview(port: PullRequestWorkflowPort, input: PullRequestWorkflowInput): Promise<{ readonly pullRequest: PullRequest; readonly review: GitReview }> {
  const pullRequest = parsePullRequest(await port.readPullRequest(input, input.pullRequestId));
  assertSelected(pullRequest, input);
  const prepared = await port.preparePullRequestReview(input);
  if (prepared.pullRequestId !== pullRequest.id || prepared.revisionId !== input.revisionId) stale();
  const review = await port.readReview(input, prepared.review.review.reviewId);
  assertReview(pullRequest, review, input);
  assertSelected(await port.readPullRequest(input, input.pullRequestId), input);
  return { pullRequest, review };
}

function assertSelected(pullRequest: PullRequest, input: PullRequestWorkflowInput): void {
  if (pullRequest.state !== "open" || pullRequest.id !== input.pullRequestId || pullRequest.version !== input.expectedVersion
    || currentRevision(pullRequest).id !== input.revisionId) stale();
}

function assertReview(pullRequest: PullRequest, review: GitReview, selector: RepositorySelector): void {
  const revision = currentRevision(pullRequest);
  if (review.namespaceId !== selector.namespaceId || review.repositoryId !== selector.repositoryId
    || review.status === "stale" || review.staleReasons.length !== 0 || review.proposalRef !== pullRequest.sourceRef
    || review.protectedRef !== pullRequest.targetRef || review.candidateCommit !== revision.sourceCommit
    || review.expectedProtectedHead !== revision.targetCommit) stale();
}

function stale(): never {
  throw new PullRequestWorkflowError("stale", "Pull request revision changed; refresh and inspect it before taking a decision");
}

export class PullRequestWorkflowError extends Error {
  readonly name = "PullRequestWorkflowError";
  constructor(readonly code: "stale" | "approval-missing" | "approval-required" | "ci-required", message: string) {
    super(message);
  }
}
