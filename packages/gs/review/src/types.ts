import type {
  BorrowedRepositoryMutationAccess,
  RepositoryAuthority,
  RepositoryMutationGate,
  RepositoryReadGate,
  RepositoryReadService,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";
import type {
  ReviewEnvelope,
  ReviewIdentity,
  ReviewAttachment,
  ReviewRequest,
} from "@slop-lab/gs-review-contracts";
import type { AuthoritativeGitReviewEvidence } from "./review-git.js";
import type { ReviewChangeMatcher } from "./change-matchers.js";

export type RepositorySnapshots = Readonly<Record<string, {
  readonly commit: string;
  readonly tree: string;
}>>;

export type ReviewPreparationInput = {
  readonly access: BorrowedRepositoryMutationAccess;
  readonly request: ReviewRequest;
  readonly target: RepositoryTarget;
  readonly evidence: AuthoritativeGitReviewEvidence;
  readonly identity: Omit<ReviewIdentity, "inputs">;
};

export interface ReviewPreparation {
  readonly name: string;
  readonly revision: string;
  prepare(input: ReviewPreparationInput): Promise<{
    readonly inputs: RepositorySnapshots;
    readonly attachment?: ReviewAttachment;
  }>;
  assertCurrent?(input: {
    readonly authority: RepositoryAuthority;
    readonly review: ReviewIdentity;
    readonly attachment?: ReviewAttachment;
  }): Promise<void>;
  accepted?(input: {
    readonly authority: RepositoryAuthority;
    readonly envelope: ReviewEnvelope;
    readonly ownerRequestId: string;
  }): Promise<void>;
}

export type ReviewFeatureHooks = {
  readonly beforeFinalVerification?: () => void | Promise<void>;
  readonly beforePublication?: (input: {
    readonly repository: string;
    readonly envelope: ReviewEnvelope;
  }) => void | Promise<void>;
  readonly publish?: (
    input: { readonly repository: string; readonly envelope: ReviewEnvelope },
    publish: () => Promise<ReviewEnvelope>,
  ) => Promise<ReviewEnvelope>;
  readonly promotionReady?: (input: {
    readonly target: RepositoryTarget;
    readonly envelope: ReviewEnvelope;
  }) => Promise<boolean>;
  readonly acceptanceCompleted?: (input: {
    readonly target: RepositoryTarget;
    readonly envelope: ReviewEnvelope;
  }) => Promise<void>;
  readonly acceptanceFailed?: (input: {
    readonly target: RepositoryTarget;
    readonly envelope: ReviewEnvelope;
    readonly cause: unknown;
  }) => Promise<void>;
};

export type ReviewFeatureOptions = {
  readonly reader: RepositoryReadService;
  readonly matchers: readonly ReviewChangeMatcher[];
  readonly preparations: readonly ReviewPreparation[];
  readonly currentAuthorityEpoch: () => string;
  readonly requirePreparationProviders?: boolean;
  readonly promotionGateRevision?: string;
  readonly hooks?: ReviewFeatureHooks;
};

export type ReviewFeatureAttachment = {
  readonly authority: RepositoryAuthority;
  readonly readGate: RepositoryReadGate;
  readonly mutationGate: RepositoryMutationGate;
};
