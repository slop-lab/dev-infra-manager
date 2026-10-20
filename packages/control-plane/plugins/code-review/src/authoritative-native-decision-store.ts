import {
  AuthoritativeNativeApprovalConflictError,
  readAuthoritativeNativeApprovals,
  saveAuthoritativeNativeApproval,
  type AuthoritativeNativeApprovalRequest
} from "./authoritative-native-approval-store.js";
import type { AuthoritativeNativeApproval } from "./authoritative-native-approval-schema.js";
import {
  readAuthoritativeNativeRevocations,
  saveAuthoritativeNativeRevocation
} from "./authoritative-native-revocation-store.js";
import type { AuthoritativeNativeRevocation } from "./authoritative-native-revocation-schema.js";

export type AuthoritativeNativeDecisions = {
  readonly approvals: readonly AuthoritativeNativeApproval[];
  readonly revocations: readonly AuthoritativeNativeRevocation[];
  readonly activeApprovals: readonly AuthoritativeNativeApproval[];
};

export async function readAuthoritativeNativeDecisions(
  repository: string,
  reviewId?: string
): Promise<AuthoritativeNativeDecisions> {
  const allApprovals = await readAuthoritativeNativeApprovals(repository);
  const allRevocations = await readAuthoritativeNativeRevocations(repository);
  const approvalById = new Map(allApprovals.map((approval) => [approval.approvalId, approval]));
  for (const revocation of allRevocations) {
    const approval = approvalById.get(revocation.approvalId);
    if (approval === undefined || approval.reviewId !== revocation.reviewId
      || approval.reviewerId !== revocation.reviewerId) {
      throw new AuthoritativeNativeDecisionStoreError("authoritative native revocation has no matching approval");
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
      throw new AuthoritativeNativeDecisionStoreError("authoritative native reviewer approval is duplicated");
    }
    activeReviewers.add(key);
  }
  return { approvals, revocations, activeApprovals };
}

export async function approveAuthoritativeNativeReview(
  request: AuthoritativeNativeApprovalRequest
): Promise<{ readonly approval: AuthoritativeNativeApproval; readonly created: boolean }> {
  const decisions = await readAuthoritativeNativeDecisions(request.repository, request.reviewId);
  const replay = decisions.approvals.find((approval) => approval.reviewerId === request.reviewerId
    && approval.requestId === request.requestId);
  if (replay !== undefined) return { approval: replay, created: false };
  if (decisions.activeApprovals.some((approval) => approval.reviewerId === request.reviewerId)) {
    throw new AuthoritativeNativeApprovalConflictError("reviewer already approved this review with another request");
  }
  return saveAuthoritativeNativeApproval(request);
}

export async function revokeAuthoritativeNativeApproval(request: {
  readonly repository: string;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly approvalId: string;
}): Promise<{ readonly revocation: AuthoritativeNativeRevocation; readonly created: boolean }> {
  const decisions = await readAuthoritativeNativeDecisions(request.repository, request.reviewId);
  const approval = decisions.approvals.find((candidate) => candidate.approvalId === request.approvalId);
  if (approval === undefined) throw new AuthoritativeNativeDecisionNotFoundError("approval was not found");
  if (approval.reviewerId !== request.reviewerId) {
    throw new AuthoritativeNativeDecisionForbiddenError("reviewer cannot revoke another reviewer's approval");
  }
  return saveAuthoritativeNativeRevocation(request);
}

export class AuthoritativeNativeDecisionStoreError extends Error {
  readonly name = "AuthoritativeNativeDecisionStoreError";
}

export class AuthoritativeNativeDecisionNotFoundError extends Error {
  readonly name = "AuthoritativeNativeDecisionNotFoundError";
}

export class AuthoritativeNativeDecisionForbiddenError extends Error {
  readonly name = "AuthoritativeNativeDecisionForbiddenError";
}
