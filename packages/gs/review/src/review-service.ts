import type {
  BorrowedRepositoryMutationAccess,
  RepositoryTargetSelector,
} from "@slop-lab/gs-repository-service";
import {
  approveReview,
  revokeReviewApproval,
} from "./decision-store.js";
import type { ReviewCreationInput } from "./review-engine.js";
import type { ReviewFeature, ReviewSelection } from "./feature.js";
import type { ReviewFeatureAttachment } from "./types.js";
import { ReviewAuthorizationError } from "./feature.js";

export class ReviewService {
  readonly #feature: ReviewFeature;
  readonly #attachment: ReviewFeatureAttachment;

  constructor(feature: ReviewFeature, attachment: ReviewFeatureAttachment) {
    this.#feature = feature;
    this.#attachment = attachment;
  }

  create(request: ReviewCreationInput) {
    return this.#attachment.mutationGate.mutate(selectorFrom(request), (access) =>
      this.#feature.createInTransaction(access, request));
  }

  createInTransaction(access: BorrowedRepositoryMutationAccess, request: ReviewCreationInput) {
    return this.#feature.createInTransaction(access, request);
  }

  inspect(input: RepositoryTargetSelector & {
    readonly reviewId: string;
    readonly principalId?: string;
  }): Promise<ReviewSelection> {
    return this.#attachment.readGate.read(input, ({ authority }) =>
      this.#feature.inspectInTransaction(authority, input, input.reviewId, input.principalId));
  }

  approve(input: RepositoryTargetSelector & {
    readonly reviewId: string;
    readonly reviewerId: string;
    readonly requestId: string;
  }) {
    return this.#attachment.mutationGate.mutate(input, async (access) => {
      const selected = await this.#feature.inspectInTransaction(access.authority, input, input.reviewId, input.reviewerId);
      if (!selected.envelope.review.requiredReviewerIds.includes(input.reviewerId)) {
        throw new ReviewAuthorizationError("reviewer is not required for this review");
      }
      if (selected.staleReasons.length > 0) throw new ReviewAuthorizationError("review is stale");
      return approveReview({
        repository: selected.target.repositoryPath,
        reviewId: input.reviewId,
        reviewerId: input.reviewerId,
        requestId: input.requestId,
      });
    });
  }

  revoke(input: RepositoryTargetSelector & {
    readonly reviewId: string;
    readonly reviewerId: string;
    readonly approvalId: string;
  }) {
    return this.#attachment.mutationGate.mutate(input, async (access) => {
      const selected = await this.#feature.inspectInTransaction(access.authority, input, input.reviewId, input.reviewerId);
      if (!selected.envelope.review.requiredReviewerIds.includes(input.reviewerId)) {
        throw new ReviewAuthorizationError("reviewer is not required for this review");
      }
      return revokeReviewApproval({
        repository: selected.target.repositoryPath,
        reviewId: input.reviewId,
        reviewerId: input.reviewerId,
        approvalId: input.approvalId,
      });
    });
  }
}

function selectorFrom(request: ReviewCreationInput): RepositoryTargetSelector {
  return {
    namespaceId: request.namespaceId,
    repositoryId: request.repositoryId,
    ...(request.protectedRef === undefined ? {} : { protectedRef: request.protectedRef }),
  };
}
