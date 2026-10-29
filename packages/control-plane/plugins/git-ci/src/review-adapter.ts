import type { Review, ReviewEnvelope, ReviewIdentity } from "@slop-lab/gs-review-contracts";
import {
  decodeDimLegacyReviewEnvelope,
  decodeDimLegacyReviewIdentity,
  encodeDimLegacyReviewIdentity,
  type AuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewIdentity,
  type AuthoritativeNativeReviewIdentityWithoutInputs,
} from "@slop-lab/gs-review-contracts/dim-legacy-codec";

export const toGsReviewEnvelope = decodeDimLegacyReviewEnvelope;
export const toDimReviewIdentity = encodeDimLegacyReviewIdentity;

export function toGsReviewIdentity(
  input: AuthoritativeNativeReviewIdentity | AuthoritativeNativeReviewEnvelope["review"],
): ReviewIdentity {
  if ("reviewId" in input) {
    const { reviewId: _reviewId, createdAt: _createdAt, ...identity } = input;
    return decodeDimLegacyReviewIdentity(identity);
  }
  return decodeDimLegacyReviewIdentity(input);
}

export function toGsReviewIdentityWithoutInputs(
  input: AuthoritativeNativeReviewIdentityWithoutInputs,
): Omit<ReviewIdentity, "inputs"> {
  return {
    schemaVersion: 1,
    namespaceId: input.projectId,
    repositoryId: input.repositoryId,
    protectedRef: input.protectedRef,
    proposalRef: input.proposalRef,
    expectedProtectedHead: input.expectedProtectedHead,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    policyRevision: input.policyRevision,
    requiredReviewRevision: input.requiredReviewRevision,
    ...(input.workspaceId === undefined ? {} : { candidatePrincipalId: input.workspaceId }),
    requiredReviewerIds: input.requiredReviewerIds,
    ...(input.changeRuleEvidence === undefined ? {} : { changeRuleEvidence: input.changeRuleEvidence }),
    changes: input.changes,
    patch: input.patch,
    patchBytes: input.patchBytes,
  };
}

export function toDimReview(input: Review): AuthoritativeNativeReviewEnvelope["review"] {
  return {
    ...encodeDimLegacyReviewIdentity(input),
    reviewId: input.reviewId,
    createdAt: input.createdAt,
  };
}

export type { AuthoritativeNativeReviewEnvelope, AuthoritativeNativeReviewIdentity, ReviewEnvelope };
