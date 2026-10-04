import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BoundedAdmissionVerifier } from "./admission-verifier.js";
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
import type { IssueJobRequest } from "./job-attempt-schema.js";
import { deriveOrdinaryExecution } from "./ordinary-execution-service.js";
import {
  approvalsComplete,
  currentAttemptEvidence,
  jobsSuccessful,
  matchesReview
} from "./promotion-evidence.js";

type ReviewTarget = {
  readonly projectId: string;
  readonly repositoryId: string;
};

type JobAttemptTarget = ReviewTarget & {
  readonly reviewId: string;
};

type JobAttemptRevocationTarget = JobAttemptTarget & {
  readonly jobName: string;
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
  issue(
    identity: NativeGitIdentity,
    target: JobAttemptTarget,
    input: IssueJobRequest
  ): Promise<{ readonly issuance: JobAttempt; readonly replayed: boolean }>;
  revokeAttempt(identity: NativeGitIdentity, target: JobAttemptRevocationTarget): Promise<JobAttemptRevocation>;
  report(identity: NativeGitIdentity, target: ReviewTarget, reviewId: string, envelope: CiStatusEnvelope): Promise<CiStatusRecord>;
  promote(identity: NativeGitIdentity, target: ReviewTarget, reviewId: string): Promise<PromotionResult>;
};

export function createPromotionService(
  config: NativeGitServiceConfig,
  serializer: RefSerializer,
  admissionVerifier: BoundedAdmissionVerifier
): PromotionService {
  return {
    async issue(identity, target, input) {
      authorizeTarget(identity, target);
      if (identity.role !== "scheduler") throw new ReviewApiError(403, "CI scheduler authority is required");
      const review = await requiredReview(config, target, target.reviewId);
      const policy = findPolicy(config, target, review.protectedRef);
      if (policy === undefined || !policy.requiredJobNames.includes(input.jobName)) {
        throw new ReviewApiError(409, "job is not required by current policy");
      }
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        const execution = await deriveOrdinaryExecution(config, target, {
          jobName: input.jobName,
          admissionGeneration: input.admissionGeneration,
          runnerBaseImage: input.runnerBaseImage,
          bounds: input.bounds
        });
        if (execution.digest !== input.descriptorDigest) {
          throw new ReviewApiError(409, "candidate execution descriptor digest changed");
        }
        await admissionVerifier.assertAdmitted({
          descriptor: execution.descriptor,
          descriptorDigest: execution.digest,
          hostId: input.hostId,
          capacity: input.capacity
        });
        try {
          return await attemptStore(config, target).issue({
            issuanceRequestId: input.issuanceRequestId,
            reviewId: target.reviewId,
            descriptor: execution.descriptor,
            descriptorDigest: execution.digest,
            hostId: input.hostId,
            capacity: input.capacity,
            issuedBy: identity.username
          });
        } catch (error) {
          if (error instanceof JobAttemptStoreError) throw new ReviewApiError(409, error.message);
          throw error;
        }
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
      if (identity.jobName !== envelope.payload.descriptor.jobName) throw new ReviewApiError(403, "CI identity cannot report this job");
      const policy = findPolicy(config, target, review.protectedRef);
      if (policy === undefined || !policy.requiredJobNames.includes(identity.jobName)) {
        throw new ReviewApiError(403, "CI job is not required by current policy");
      }
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        const reviewStatus = await status(config, review);
        if (reviewStatus.status === "stale" || !matchesReview(envelope, review)) {
          throw new ReviewApiError(409, "CI status tuple does not match the current review");
        }
        const current = await attemptStore(config, target).current(reviewId, identity.jobName);
        if (current === undefined || current.revocation !== undefined
          || current.issuance.attempt !== envelope.payload.attempt
          || current.issuance.attemptId !== envelope.payload.attemptId
          || current.issuance.descriptorDigest !== envelope.payload.descriptorDigest
          || current.issuance.hostId !== envelope.payload.hostId
          || current.issuance.capacity !== envelope.payload.capacity
          || !isDeepStrictEqual(current.issuance.descriptor, envelope.payload.descriptor)) {
          throw new ReviewApiError(409, "CI status does not match the current issued attempt");
        }
        await admissionVerifier.assertCurrentAttempt(currentAttemptEvidence(current.issuance));
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
        if (!allowedStaleness || !approvalsComplete(current)
          || !await jobsSuccessful(config, current, admissionVerifier)) {
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
