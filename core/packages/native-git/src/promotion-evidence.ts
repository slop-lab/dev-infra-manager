import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type { BoundedAdmissionVerifier, CurrentAttemptEvidence } from "./admission-verifier.js";
import type { NativeGitServiceConfig } from "./config.js";
import { createJobAttemptStore } from "./job-attempt-store.js";
import type { JobAttempt } from "./job-attempt-schema.js";
import type { CiStatusEnvelope } from "./promotion-schema.js";
import type { ReviewObject } from "./review-schema.js";
import { findPolicy, type ReviewStatus } from "./review-service.js";

export function approvalsComplete(review: ReviewStatus): boolean {
  const revoked = new Set(review.revocations.map((revocation) => revocation.approvalId));
  const active = new Set(review.approvals
    .filter((approval) => !revoked.has(approval.approvalId))
    .map((approval) => approval.reviewerId));
  return review.requiredReviewerIds.every((reviewerId) => active.has(reviewerId));
}

export async function jobsSuccessful(
  config: NativeGitServiceConfig,
  review: ReviewStatus,
  admissionVerifier: BoundedAdmissionVerifier
): Promise<boolean> {
  const policy = findPolicy(config, review, review.protectedRef);
  if (policy === undefined) return false;
  const store = createJobAttemptStore(join(
    config.storageRoot,
    review.projectId,
    `${review.repositoryId}.git`
  ));
  const results = await Promise.all(policy.requiredJobNames.map(async (jobName) => {
    const current = await store.current(review.reviewId, jobName);
    if (current === undefined || current.revocation !== undefined) return false;
    const latest = review.statuses.find((record) => record.payload.descriptor.jobName === jobName
      && record.payload.attempt === current.issuance.attempt
      && record.payload.attemptId === current.issuance.attemptId);
    const reporterUsername = config.ordinaryCi?.resultReporter.username;
    if (latest === undefined || latest.payload.result !== "success"
      || latest.payload.completion.kind !== "exited" || latest.payload.completion.exitCode !== 0
      || latest.reporterUsername !== reporterUsername || !matchesReview(latest, review)
      || latest.payload.descriptorDigest !== current.issuance.descriptorDigest
      || latest.payload.hostId !== current.issuance.hostId
      || latest.payload.capacity !== current.issuance.capacity
      || !isDeepStrictEqual(latest.payload.descriptor, current.issuance.descriptor)) return false;
    await admissionVerifier.assertCurrentAttempt(currentAttemptEvidence(current.issuance));
    return true;
  }));
  return results.every((result) => result);
}

export function matchesReview(envelope: CiStatusEnvelope, review: ReviewStatus | ReviewObject): boolean {
  const payload = envelope.payload;
  const descriptor = payload.descriptor;
  return payload.reviewId === review.reviewId
    && descriptor.projectId === review.projectId && descriptor.repositoryId === review.repositoryId
    && descriptor.protectedRef === review.protectedRef
    && descriptor.expectedProtectedHead === review.expectedProtectedHead
    && descriptor.candidateCommit === review.candidateCommit && descriptor.candidateTree === review.candidateTree
    && descriptor.policyRevision === review.policyRevision
    && descriptor.requiredReviewRevision === review.requiredReviewRevision
    && descriptor.requiredJobSetRevision === review.requiredJobSetRevision;
}

export function currentAttemptEvidence(issuance: JobAttempt): CurrentAttemptEvidence {
  return {
    reviewId: issuance.reviewId,
    attemptId: issuance.attemptId,
    descriptorDigest: issuance.descriptorDigest,
    admissionGeneration: issuance.descriptor.admissionGeneration,
    hostId: issuance.hostId,
    capacity: issuance.capacity
  };
}
