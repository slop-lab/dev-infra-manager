import type { ReviewEnvelope } from "@slop-lab/gs-review-contracts";
import { PullRequestConflict } from "@slop-lab/gs-pull-requests";

export type PullRequestReviewAssociation = {
  readonly namespaceId: string;
  readonly repositoryId: string;
  readonly proposalRef: string;
  readonly protectedRef: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly targetCommit: string;
};

export type PullRequestReviewResult = {
  readonly pullRequestId: string;
  readonly revisionId: string;
  readonly review: ReviewEnvelope;
};

export function assertMatchingReview(
  envelope: ReviewEnvelope,
  expected: PullRequestReviewAssociation,
): void {
  const review = envelope.review;
  const input = review.inputs[expected.repositoryId];
  if (review.namespaceId !== expected.namespaceId
    || review.repositoryId !== expected.repositoryId
    || review.proposalRef !== expected.proposalRef
    || review.protectedRef !== expected.protectedRef
    || review.candidateCommit !== expected.sourceCommit
    || review.candidateTree !== expected.sourceTree
    || review.expectedProtectedHead !== expected.targetCommit
    || input?.commit !== expected.sourceCommit
    || input.tree !== expected.sourceTree) {
    throw new PullRequestConflict("Review does not match pull request revision");
  }
}
