import { join } from "node:path";
import type { NativeGitIdentity, NativeGitServiceConfig } from "./config.js";
import type { ReviewObject } from "./review-schema.js";
import {
  ciStatusRecordSchema,
  statusDigest,
  type CiStatusEnvelope,
  type CiStatusRecord
} from "./promotion-schema.js";
import {
  candidateDescendsFrom,
  atomicPromote
} from "./promotion-git.js";
import { liveReviewObjects } from "./review-git.js";
import { refSerializationKey, type RefSerializer } from "./ref-serializer.js";
import {
  findPolicy,
  requiredReview,
  ReviewApiError,
  status,
  type ReviewStatus
} from "./review-service.js";
import { createStatusStore, StatusConflictError } from "./status-store.js";
import { createJobAttemptStore, JobAttemptStoreError } from "./job-attempt-store.js";
import type { JobAttempt, JobAttemptRevocation } from "./job-attempt-schema.js";

type ReviewTarget = {
  readonly projectId: string;
  readonly repositoryId: string;
};

type JobAttemptTarget = ReviewTarget & {
  readonly reviewId: string;
  readonly jobName: string;
};

type JobAttemptRevocationTarget = JobAttemptTarget & {
  readonly attemptId: string;
};

export type PromotionResult = {
  readonly outcome: "promoted" | "already-current";
  readonly reviewId: string;
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
};

export type PromotionService = {
  issue(identity: NativeGitIdentity, target: JobAttemptTarget): Promise<JobAttempt>;
  revokeAttempt(identity: NativeGitIdentity, target: JobAttemptRevocationTarget): Promise<JobAttemptRevocation>;
  report(identity: NativeGitIdentity, target: ReviewTarget, reviewId: string, envelope: CiStatusEnvelope): Promise<CiStatusRecord>;
  promote(identity: NativeGitIdentity, target: ReviewTarget, reviewId: string): Promise<PromotionResult>;
};

export function createPromotionService(config: NativeGitServiceConfig, serializer: RefSerializer): PromotionService {
  return {
    async issue(identity, target) {
      authorizeTarget(identity, target);
      if (identity.role !== "scheduler") throw new ReviewApiError(403, "CI scheduler authority is required");
      const review = await requiredReview(config, target, target.reviewId);
      const policy = findPolicy(config, target, review.protectedRef);
      if (policy === undefined || !policy.requiredJobNames.includes(target.jobName)) {
        throw new ReviewApiError(409, "job is not required by current policy");
      }
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        const current = await status(config, review);
        if (current.status === "stale") throw new ReviewApiError(409, "review tuple is stale");
        return attemptStore(config, target).issue({
          reviewId: target.reviewId,
          projectId: target.projectId,
          repositoryId: target.repositoryId,
          jobName: target.jobName,
          issuedBy: identity.username
        });
      });
    },
    async revokeAttempt(identity, target) {
      authorizeTarget(identity, target);
      if (identity.role !== "scheduler") throw new ReviewApiError(403, "CI scheduler authority is required");
      const review = await requiredReview(config, target, target.reviewId);
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        try {
          return await attemptStore(config, target).revoke({
            reviewId: target.reviewId,
            jobName: target.jobName,
            attemptId: target.attemptId,
            revokedBy: identity.username
          });
        } catch (error) {
          if (error instanceof JobAttemptStoreError) throw new ReviewApiError(404, error.message);
          throw error;
        }
      });
    },
    async report(identity, target, reviewId, envelope) {
      authorizeTarget(identity, target);
      if (identity.role !== "ci") throw new ReviewApiError(403, "CI job authority is required");
      const review = await requiredReview(config, target, reviewId);
      if (identity.jobName !== envelope.payload.jobName) throw new ReviewApiError(403, "CI identity cannot report this job");
      const policy = findPolicy(config, target, review.protectedRef);
      if (policy === undefined || !policy.requiredJobNames.includes(identity.jobName)) {
        throw new ReviewApiError(403, "CI job is not required by current policy");
      }
      if (!matchesReview(envelope, review)) throw new ReviewApiError(409, "CI status tuple does not match the review");
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        const current = await attemptStore(config, target).current(reviewId, identity.jobName);
        if (current === undefined || current.revocation !== undefined
          || current.issuance.attempt !== envelope.payload.attempt
          || current.issuance.attemptId !== envelope.payload.attemptId) {
          throw new ReviewApiError(409, "CI status does not match the current issued attempt");
        }
        const identityRecord = {
          ...envelope,
          reviewId,
          reporterUsername: identity.username
        };
        const record = ciStatusRecordSchema.parse({
          ...identityRecord,
          statusId: statusDigest(identityRecord),
          reportedAt: new Date().toISOString()
        });
        try {
          return await statusStore(config, target).saveStatus(record);
        } catch (error) {
          if (error instanceof StatusConflictError) throw new ReviewApiError(409, error.message);
          throw error;
        }
      });
    },
    async promote(identity, target, reviewId) {
      authorizeTarget(identity, target);
      if (identity.role !== "promoter") throw new ReviewApiError(403, "protected promotion authority is required");
      const review = await requiredReview(config, target, reviewId);
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        const current = await status(config, review);
        const live = await liveReviewObjects(config, review);
        const currentHead = live.protectedHead;
        if (currentHead === undefined) throw new ReviewApiError(409, "protected ref is missing");
        const alreadyCurrent = currentHead === review.candidateCommit;
        const allowedStaleness = current.staleReasons.every((reason) => alreadyCurrent && reason === "protected-head-changed");
        if (!allowedStaleness || !approvalsComplete(current) || !await jobsSuccessful(config, current)) {
          throw new ReviewApiError(409, "promotion evidence is incomplete or stale");
        }
        if (!await candidateDescendsFrom(config, target, review.expectedProtectedHead, review.candidateCommit)) {
          throw new ReviewApiError(409, "candidate does not descend from the expected protected head");
        }
        if (alreadyCurrent) return promotionResult("already-current", review, review.expectedProtectedHead);
        if (currentHead !== review.expectedProtectedHead) throw new ReviewApiError(409, "protected head changed");
        const updated = await atomicPromote(config, review, review.expectedProtectedHead, review.candidateCommit);
        if (!updated) {
          const after = await liveReviewObjects(config, review);
          if (after.protectedHead === review.candidateCommit) {
            return promotionResult("already-current", review, review.expectedProtectedHead);
          }
          throw new ReviewApiError(409, "protected ref compare-and-swap failed");
        }
        return promotionResult("promoted", review, review.expectedProtectedHead);
      });
    }
  };
}

function approvalsComplete(review: ReviewStatus): boolean {
  const revoked = new Set(review.revocations.map((revocation) => revocation.approvalId));
  const active = new Set(review.approvals.filter((approval) => !revoked.has(approval.approvalId)).map((approval) => approval.reviewerId));
  return review.requiredReviewerIds.every((reviewerId) => active.has(reviewerId));
}

async function jobsSuccessful(config: NativeGitServiceConfig, review: ReviewStatus): Promise<boolean> {
  const policy = findPolicy(config, review, review.protectedRef);
  if (policy === undefined) return false;
  const target = { projectId: review.projectId, repositoryId: review.repositoryId };
  const store = attemptStore(config, target);
  const results = await Promise.all(policy.requiredJobNames.map(async (jobName) => {
    const current = await store.current(review.reviewId, jobName);
    if (current === undefined || current.revocation !== undefined) return false;
    const latest = review.statuses.find((record) => record.payload.jobName === jobName
      && record.payload.attempt === current.issuance.attempt
      && record.payload.attemptId === current.issuance.attemptId);
    const reporter = config.identities.find((identity) => identity.role === "ci" && identity.jobName === jobName
      && identity.projectId === review.projectId && identity.repositoryIds.includes(review.repositoryId));
    return latest?.payload.result === "success" && latest.reporterUsername === reporter?.username
      && matchesReview(latest, review);
  }));
  return results.every((result) => result);
}

function matchesReview(envelope: CiStatusEnvelope, review: ReviewStatus | ReviewObject): boolean {
  const payload = envelope.payload;
  return payload.projectId === review.projectId && payload.repositoryId === review.repositoryId
    && payload.protectedRef === review.protectedRef && payload.expectedProtectedHead === review.expectedProtectedHead
    && payload.candidateCommit === review.candidateCommit && payload.candidateTree === review.candidateTree
    && payload.policyRevision === review.policyRevision && payload.requiredReviewRevision === review.requiredReviewRevision
    && payload.requiredJobSetRevision === review.requiredJobSetRevision;
}

function authorizeTarget(identity: NativeGitIdentity, target: ReviewTarget): void {
  if (identity.projectId !== target.projectId || !identity.repositoryIds.includes(target.repositoryId)) {
    throw new ReviewApiError(404, "repository was not found");
  }
}

function statusStore(config: NativeGitServiceConfig, target: ReviewTarget) {
  return createStatusStore(join(config.storageRoot, target.projectId, `${target.repositoryId}.git`));
}

function attemptStore(config: NativeGitServiceConfig, target: ReviewTarget) {
  return createJobAttemptStore(join(config.storageRoot, target.projectId, `${target.repositoryId}.git`));
}

function promotionResult(
  outcome: PromotionResult["outcome"],
  review: ReviewObject,
  expectedProtectedHead: string
): PromotionResult {
  return {
    outcome,
    reviewId: review.reviewId,
    protectedRef: review.protectedRef,
    expectedProtectedHead,
    candidateCommit: review.candidateCommit,
    candidateTree: review.candidateTree
  };
}
