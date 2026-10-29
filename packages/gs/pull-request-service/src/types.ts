import type { PullRequestRefWriter } from "./refs.js";
import type { ReviewEnvelope, ReviewRequest } from "@slop-lab/gs-review-contracts";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type {
  BorrowedRepositoryMutationAccess,
  RepositoryMutationGate,
  RepositoryReadGate,
  RepositoryReadService,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";

export interface RepositoryPrincipalScope {
  readonly principalId: string;
  authorize(target: RepositoryTarget): Promise<void>;
}

export interface OptionalReviewRequest {
  request(input: { readonly access: BorrowedRepositoryMutationAccess; readonly request: ReviewRequest }): Promise<ReviewEnvelope>;
}

export type PullRequestServiceOptions = {
  readonly stateDirectory: string;
  readonly readGate: RepositoryReadGate;
  readonly mutationGate: RepositoryMutationGate;
  readonly reader: RepositoryReadService;
  readonly refWriter: PullRequestRefWriter;
  readonly reviewRequest?: OptionalReviewRequest;
  readonly now?: () => string;
  readonly newId?: () => string;
};

export type CreatePullRequest = RepositorySelector & {
  readonly principal: RepositoryPrincipalScope;
  readonly title: string;
  readonly body?: string;
  readonly sourceRef: string;
  readonly targetRef?: string;
  readonly signal?: AbortSignal;
};
