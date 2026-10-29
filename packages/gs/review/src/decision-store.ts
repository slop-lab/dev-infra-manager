import type {
  ReviewApproval,
  ReviewRevocation,
} from "@slop-lab/gs-review-contracts";
import {
  ReviewApprovalConflictError,
  readReviewApprovals,
  saveReviewApproval,
  type ReviewApprovalRequest,
} from "./approval-store.js";
import {
  readReviewRevocations,
  saveReviewRevocation,
} from "./revocation-store.js";

export type ReviewDecisions = {
  readonly approvals: readonly ReviewApproval[];
  readonly revocations: readonly ReviewRevocation[];
  readonly activeApprovals: readonly ReviewApproval[];
};

export async function readReviewDecisions(
  repository: string,
  reviewId?: string,
): Promise<ReviewDecisions> {
  const allApprovals = await readReviewApprovals(repository);
  const allRevocations = await readReviewRevocations(repository);
  const approvalById = new Map(allApprovals.map((approval) => [approval.approvalId, approval]));
  for (const revocation of allRevocations) {
    const approval = approvalById.get(revocation.approvalId);
    if (approval === undefined || approval.reviewId !== revocation.reviewId
      || approval.reviewerId !== revocation.reviewerId) {
      throw new ReviewDecisionStoreError("review revocation has no matching approval");
    }
  }
  const revocations = reviewId === undefined
    ? allRevocations
    : allRevocations.filter((revocation) => revocation.reviewId === reviewId);
  const approvals = reviewId === undefined
    ? allApprovals
    : allApprovals.filter((approval) => approval.reviewId === reviewId);
  const revoked = new Set(revocations.map((revocation) => revocation.approvalId));
  const activeApprovals = approvals.filter((approval) => !revoked.has(approval.approvalId));
  const activeReviewers = new Set<string>();
  for (const approval of activeApprovals) {
    const key = `${approval.reviewId}\0${approval.reviewerId}`;
    if (activeReviewers.has(key)) {
      throw new ReviewDecisionStoreError("reviewer approval is duplicated");
    }
    activeReviewers.add(key);
  }
  return { approvals, revocations, activeApprovals };
}

export async function approveReview(
  request: ReviewApprovalRequest,
): Promise<{ readonly approval: ReviewApproval; readonly created: boolean }> {
  const decisions = await readReviewDecisions(request.repository, request.reviewId);
  const replay = decisions.approvals.find((approval) => approval.reviewerId === request.reviewerId
    && approval.requestId === request.requestId);
  if (replay !== undefined) return { approval: replay, created: false };
  if (decisions.activeApprovals.some((approval) => approval.reviewerId === request.reviewerId)) {
    throw new ReviewApprovalConflictError("reviewer already approved this review with another request");
  }
  return saveReviewApproval(request);
}

export async function revokeReviewApproval(request: {
  readonly repository: string;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly approvalId: string;
}): Promise<{ readonly revocation: ReviewRevocation; readonly created: boolean }> {
  const decisions = await readReviewDecisions(request.repository, request.reviewId);
  const approval = decisions.approvals.find((candidate) => candidate.approvalId === request.approvalId);
  if (approval === undefined) throw new ReviewDecisionNotFoundError("approval was not found");
  if (approval.reviewerId !== request.reviewerId) {
    throw new ReviewDecisionForbiddenError("reviewer cannot revoke another reviewer's approval");
  }
  return saveReviewRevocation(request);
}

export class ReviewDecisionStoreError extends Error {
  readonly name = "ReviewDecisionStoreError";
}

export class ReviewDecisionNotFoundError extends Error {
  readonly name = "ReviewDecisionNotFoundError";
}

export class ReviewDecisionForbiddenError extends Error {
  readonly name = "ReviewDecisionForbiddenError";
}
