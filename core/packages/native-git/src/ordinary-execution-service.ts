import {
  loadCandidateOrdinaryExecution,
  type CandidateOrdinaryExecution
} from "./candidate-execution.js";
import {
  CandidateExecutionError,
  type OrdinaryExecutionDescriptorRequest
} from "./candidate-execution-schema.js";
import type { NativeGitIdentity, NativeGitServiceConfig } from "./config.js";
import { refSerializationKey, type RefSerializer } from "./ref-serializer.js";
import {
  findPolicy,
  requiredReview,
  ReviewApiError,
  status
} from "./review-service.js";

type DescriptorTarget = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly reviewId: string;
};

export type OrdinaryExecutionDescriptorResponse = CandidateOrdinaryExecution & {
  readonly reviewId: string;
};

export type OrdinaryExecutionService = {
  authorize(identity: NativeGitIdentity, target: DescriptorTarget): void;
  load(target: DescriptorTarget, input: OrdinaryExecutionDescriptorRequest): Promise<OrdinaryExecutionDescriptorResponse>;
};

export function createOrdinaryExecutionService(
  config: NativeGitServiceConfig,
  serializer: RefSerializer
): OrdinaryExecutionService {
  return {
    authorize: authorizeScheduler,
    async load(target, input) {
      const review = await requiredReview(config, target, target.reviewId);
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        const before = await status(config, review);
        if (before.status === "stale") throw new ReviewApiError(409, "review tuple is stale");
        const policy = findPolicy(config, target, review.protectedRef);
        if (policy === undefined || !policy.requiredJobNames.includes(input.jobName)) {
          throw new ReviewApiError(409, "job is not required by current policy");
        }
        let execution: CandidateOrdinaryExecution;
        try {
          execution = await loadCandidateOrdinaryExecution(config, {
            projectId: review.projectId,
            repositoryId: review.repositoryId,
            protectedRef: review.protectedRef,
            expectedProtectedHead: review.expectedProtectedHead,
            candidateCommit: review.candidateCommit,
            candidateTree: review.candidateTree,
            policyRevision: review.policyRevision,
            requiredReviewRevision: review.requiredReviewRevision,
            requiredJobSetRevision: review.requiredJobSetRevision,
            ...input
          });
        } catch (error) {
          if (error instanceof CandidateExecutionError) throw new ReviewApiError(409, error.message);
          throw error;
        }
        const after = await status(config, review);
        if (after.status === "stale") throw new ReviewApiError(409, "review tuple became stale");
        return { reviewId: review.reviewId, ...execution };
      });
    }
  };
}

function authorizeScheduler(identity: NativeGitIdentity, target: DescriptorTarget): void {
  if (identity.projectId !== target.projectId || !identity.repositoryIds.includes(target.repositoryId)) {
    throw new ReviewApiError(404, "repository was not found");
  }
  if (identity.role !== "scheduler") throw new ReviewApiError(403, "CI scheduler authority is required");
}
