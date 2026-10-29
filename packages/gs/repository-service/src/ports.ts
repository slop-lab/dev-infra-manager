import type {
  ProtectedRefChange,
  ProtectedRefFinalized,
  ProtectedRefFinalizedQuery,
  ProtectedRefReceipt,
  ProtectedRefTarget as CoreProtectedRefTarget,
} from "@slop-lab/gs-repository";
import type {
  Namespace,
  RepositoryPolicy,
  RepositorySelector,
} from "@slop-lab/gs-repository-contracts";

export type RepositoryTargetSelector = RepositorySelector & {
  readonly protectedRef?: string;
};

export type RepositoryTarget = CoreProtectedRefTarget & {
  readonly policy: RepositoryPolicy;
};

export type RepositoryAvailability =
  | { readonly kind: "available"; readonly target: RepositoryTarget }
  | { readonly kind: "not-found" }
  | { readonly kind: "recovery-required" };

export interface RepositoryAuthority {
  readonly authorityEpoch: string;
  resolve(selector: RepositoryTargetSelector): Promise<RepositoryTarget>;
  assertCurrent(target: RepositoryTarget): Promise<void>;
  list(namespace: Namespace): Promise<readonly RepositoryTarget[]>;
  listSelectors(namespace?: Namespace): Promise<readonly RepositorySelector[]>;
  availability(selector: RepositoryTargetSelector): Promise<RepositoryAvailability>;
  findFinalized(query: ProtectedRefFinalizedQuery): Promise<ProtectedRefFinalized | undefined>;
}

export interface BorrowedRepositoryReadAuthority extends RepositoryAuthority {}

export interface BorrowedRepositoryMutationAuthority extends BorrowedRepositoryReadAuthority, ProtectedRefPromotionService {}

export type BorrowedRepositoryReadAccess = {
  readonly authority: BorrowedRepositoryReadAuthority;
  readonly target: RepositoryTarget;
};

export type BorrowedRepositoryMutationAccess = {
  readonly authority: BorrowedRepositoryMutationAuthority;
  readonly target: RepositoryTarget;
};

export interface RepositoryReadGate {
  read<Result>(selector: RepositoryTargetSelector, operation: (access: BorrowedRepositoryReadAccess) => Promise<Result>): Promise<Result>;
}

export interface RepositoryMutationGate {
  mutate<Result>(selector: RepositoryTargetSelector, operation: (access: BorrowedRepositoryMutationAccess) => Promise<Result>): Promise<Result>;
}

export interface RepositoryExclusiveGate {
  exclusive<Result>(operation: (authority: BorrowedRepositoryMutationAuthority) => Promise<Result>): Promise<Result>;
}

export interface RefUpdatePolicy {
  readonly name: string;
  readonly revision: string;
  authorize(input: {
    readonly authority: BorrowedRepositoryReadAuthority;
    readonly change: ProtectedRefChange;
    readonly target: CoreProtectedRefTarget;
    readonly policy: RepositoryPolicy;
  }): Promise<void>;
}

export interface PolicySectionOwner<Section = unknown> {
  readonly sectionName: string;
  readonly enforcement: "configuration" | "authorization";
  parse(value: unknown): Section;
}

export interface ProposalConsumer {
  consume(input: {
    readonly selector: RepositorySelector;
    readonly refs: readonly string[];
  }): Promise<void>;
}

export interface OwnedRefProvider {
  ownedRefs(selector: RepositorySelector): Promise<readonly {
    readonly ref: string;
    readonly commit: string;
  }[]>;
}

export type RepositoryAccess = {
  readonly principalId: string;
  readonly target: RepositoryTarget;
};

export type RepositoryBlobMetadata = {
  readonly blobId: string;
  readonly lineCount: number | null;
  readonly byteLength: number;
  readonly mode: string;
};

export interface RepositoryReadService {
  readBytes(input: {
    readonly access: RepositoryAccess;
    readonly args: readonly string[];
    readonly signal: AbortSignal;
    readonly standardInput?: Uint8Array;
    readonly maximumBytes?: number;
  }): Promise<Uint8Array>;
  assertAdvertisedCommits(input: {
    readonly access: RepositoryAccess;
    readonly commits: readonly string[];
    readonly advertisedRefs?: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<void>;
  readTreeFile(input: {
    readonly access: RepositoryAccess;
    readonly commit: string;
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<RepositoryBlobMetadata | null>;
  readRef(access: RepositoryAccess, ref: string): Promise<string>;
  readCommitTree(access: RepositoryAccess, commit: string): Promise<string>;
}

export interface ProtectedRefPromotionService {
  promote(change: ProtectedRefChange): Promise<ProtectedRefReceipt>;
}
