import { createHash } from "node:crypto";
import type {
  BorrowedRepositoryMutationAccess,
  PolicySectionOwner,
  RefUpdatePolicy,
  RepositoryAuthority,
  RepositoryMutationGate,
  RepositoryReadService,
  RepositoryTarget,
  RepositoryTargetSelector,
} from "@slop-lab/gs-repository-service";
import type { ReviewFeature } from "@slop-lab/gs-review";
import type { AuthoritativeNativeReviewEnvelope } from "@slop-lab/gs-review-contracts";
import { MergeAuthorizationStore, type MergeAuthorization } from "./state.js";
import {
  assertMergeQualityGuards,
  assertRequiredMergeQualityGuards,
  type MergeEvidenceAttachment,
  type MergeQualityGuard,
} from "./quality.js";
import { MergePolicyService } from "./service.js";
import { assertTargetProof, mergeFinalizedQuery, promotionResult } from "./authorization.js";
import { mergePolicySectionOwner } from "./policy.js";

export type MergePolicyFeatureOptions = {
  readonly statePath?: string;
  readonly authorizationStore?: MergeAuthorizationStore;
  readonly reviewFeature: ReviewFeature;
  readonly reader: RepositoryReadService;
  readonly qualityGuards: readonly MergeQualityGuard[];
  readonly selectedRefPolicyNames: readonly string[];
  readonly integrationPolicyNames: readonly string[];
};

export type MergePolicyAttachment = {
  readonly authority: RepositoryAuthority;
  readonly mutationGate: RepositoryMutationGate;
};

export type MergePromotionResult = {
  readonly schemaVersion: 1;
  readonly outcome: "promoted" | "already-current";
  readonly reviewId: string;
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly sequence: number;
};

export type MergePromotionHooks = {
  readonly afterIntent?: () => void | Promise<void>;
  readonly afterCompareAndSwap?: () => void | Promise<void>;
};

export class MergePolicyFeature {
  readonly refUpdatePolicy: RefUpdatePolicy;
  readonly policySectionOwner: PolicySectionOwner = mergePolicySectionOwner;
  readonly #options: MergePolicyFeatureOptions;
  readonly #store: MergeAuthorizationStore;
  readonly #ownsStore: boolean;

  constructor(options: MergePolicyFeatureOptions) {
    assertMergeQualityGuards(options.qualityGuards);
    if ((options.statePath === undefined) === (options.authorizationStore === undefined)) {
      throw new MergePolicyError("merge policy requires exactly one authorization store owner");
    }
    this.#options = options;
    this.#store = options.authorizationStore ?? new MergeAuthorizationStore(options.statePath ?? "");
    this.#ownsStore = options.authorizationStore === undefined;
    this.refUpdatePolicy = {
      name: "merge-policy",
      revision: featureRevision(options),
      authorize: (input) => this.#authorizeRefUpdate(input),
    };
  }

  attach(attachment: MergePolicyAttachment): MergePolicyService {
    return new MergePolicyService(this, attachment.mutationGate);
  }

  close(): void {
    if (this.#ownsStore) this.#store.close();
  }

  get authorizationStore(): MergeAuthorizationStore {
    return this.#store;
  }

  async recover(authority: RepositoryAuthority): Promise<void> {
    for (const entry of this.#store.read()) {
      if (entry.sequence !== undefined) continue;
      const query = mergeFinalizedQuery(entry);
      if (query === undefined) continue;
      const finalized = await authority.findFinalized(query);
      if (finalized !== undefined) this.#store.finalize(entry.authorizationId, finalized.receipt.sequence);
    }
  }

  async promoteInTransaction(
    access: BorrowedRepositoryMutationAccess,
    input: RepositoryTargetSelector & { readonly reviewId: string },
    hooks: MergePromotionHooks = {},
  ): Promise<MergePromotionResult> {
    {
      const selected = await this.#options.reviewFeature.inspectInTransaction(
        access.authority,
        input,
        input.reviewId,
        undefined,
        false,
      );
      const { review } = selected.envelope;
      const previous = this.#store.read().find((entry) => entry.authorization.projectId === input.namespaceId
        && entry.authorization.repositoryId === input.repositoryId
        && entry.authorization.reviewId === input.reviewId && entry.sequence !== undefined);
      if (previous?.sequence !== undefined && selected.target.head.commit === previous.authorization.candidateCommit
        && review.candidateCommit === previous.authorization.candidateCommit
        && review.candidateTree === previous.authorization.candidateTree) {
        return promotionResult("already-current", previous.authorization, previous.sequence);
      }
      if (selected.staleReasons.length > 0) throw new MergePolicyError("review security tuple is stale");
      if (selected.envelope.policyDigest !== selected.target.policyDigest) {
        throw new MergePolicyError("review policy digest is stale");
      }
      const approvals = [...selected.decisions.activeApprovals]
        .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
      if (JSON.stringify(approvals.map(({ reviewerId }) => reviewerId))
        !== JSON.stringify(review.requiredReviewerIds)) {
        throw new MergePolicyError("human approval evidence is incomplete");
      }
      const attachments = await this.#qualityEvidence(selected.target, selected.envelope);
      const authorization: MergeAuthorization = {
        projectId: input.namespaceId,
        repositoryId: input.repositoryId,
        reviewId: input.reviewId,
        generationId: access.authority.authorityEpoch,
        envelopeId: selected.envelope.envelopeId,
        policyDigest: selected.envelope.policyDigest,
        protectedRef: review.protectedRef,
        proposalRef: review.proposalRef,
        expectedCommit: review.expectedProtectedHead,
        candidateCommit: review.candidateCommit,
        candidateTree: review.candidateTree,
        approvals: approvals.map(({ reviewerId, recordDigest }) => ({ reviewerId, recordDigest })),
        attachments,
      };
      const prepared = this.#store.prepare(authorization, {
        expectedTree: selected.target.head.tree,
        incarnationId: selected.target.incarnationId,
        authorityEpoch: selected.target.authorityEpoch,
        ownerPrincipalId: selected.target.ownerPrincipalId,
        refPolicyRevision: selected.target.refPolicyRevision,
      });
      await hooks.afterIntent?.();
      const receipt = await access.authority.promote({
        namespaceId: input.namespaceId,
        repositoryId: input.repositoryId,
        protectedRef: review.protectedRef,
        proposalRef: authorization.proposalRef,
        expectedCommit: authorization.expectedCommit,
        candidateCommit: authorization.candidateCommit,
        candidateTree: authorization.candidateTree,
        authorizationId: prepared.authorizationId,
        evidenceDigest: prepared.evidenceDigest,
      });
      await hooks.afterCompareAndSwap?.();
      this.#store.finalize(prepared.authorizationId, receipt.sequence);
      return promotionResult(receipt.outcome, authorization, receipt.sequence);
    }
  }

  async #authorizeRefUpdate(input: Parameters<RefUpdatePolicy["authorize"]>[0]): Promise<void> {
    if (!Object.hasOwn(input.policy.extensions, "merge-policy")) return;
    const authority = input.authority;
    const target = await authority.resolve({
      namespaceId: input.change.namespaceId,
      repositoryId: input.change.repositoryId,
      protectedRef: input.target.head.protectedRef,
    });
    assertTargetProof(input.target, target);
    const entry = this.#store.read().find(({ authorizationId }) => authorizationId === input.change.authorizationId);
    const value = entry?.authorization;
    if (entry === undefined || value === undefined || entry.sequence !== undefined
      || entry.evidenceDigest !== input.change.evidenceDigest
      || value.projectId !== input.change.namespaceId || value.repositoryId !== input.change.repositoryId
      || value.generationId !== authority.authorityEpoch || value.policyDigest !== target.policyDigest
      || value.protectedRef !== target.head.protectedRef || value.proposalRef !== input.change.proposalRef
      || value.expectedCommit !== input.change.expectedCommit || value.candidateCommit !== input.change.candidateCommit
      || value.candidateTree !== input.change.candidateTree) {
      throw new MergePolicyError("protected ref requires an exact owned merge authorization");
    }
    const selected = await this.#options.reviewFeature.inspectInTransaction(
      authority,
      target.selector,
      value.reviewId,
      undefined,
      false,
    );
    if (selected.envelope.envelopeId !== value.envelopeId || selected.staleReasons.length > 0) {
      throw new MergePolicyError("merge authorization review is stale");
    }
    const approvals = selected.decisions.activeApprovals
      .map(({ reviewerId, recordDigest }) => ({ reviewerId, recordDigest }))
      .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
    if (JSON.stringify(approvals) !== JSON.stringify(value.approvals)) {
      throw new MergePolicyError("merge authorization approvals changed");
    }
    const attachments = await this.#qualityEvidence(target, selected.envelope);
    if (JSON.stringify(attachments) !== JSON.stringify(value.attachments)) {
      throw new MergePolicyError("merge authorization quality evidence changed");
    }
  }

  async #qualityEvidence(
    target: RepositoryTarget,
    envelope: AuthoritativeNativeReviewEnvelope,
  ): Promise<readonly MergeEvidenceAttachment[]> {
    const reviewAttachments = envelope.attachments;
    assertRequiredMergeQualityGuards({
      policyExtensions: target.policy.extensions,
      attachments: reviewAttachments,
      guards: this.#options.qualityGuards,
      refPolicyNames: this.#options.selectedRefPolicyNames,
      integrationPolicyNames: this.#options.integrationPolicyNames,
    });
    const attachments: MergeEvidenceAttachment[] = [];
    for (const guard of this.#options.qualityGuards) {
      attachments.push(...await guard.check({
        namespaceId: target.selector.namespaceId,
        repositoryId: target.selector.repositoryId,
        reviewId: envelope.review.reviewId,
        repository: target.repositoryPath,
        candidateCommit: envelope.review.candidateCommit,
        candidateTree: envelope.review.candidateTree,
        expectedProtectedHead: envelope.review.expectedProtectedHead,
        policyDigest: target.policyDigest,
        attachments: reviewAttachments,
      }));
    }
    return attachments.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  }
}

export function openMergePolicyFeature(options: MergePolicyFeatureOptions): MergePolicyFeature {
  return new MergePolicyFeature(options);
}

function featureRevision(options: MergePolicyFeatureOptions): string {
  return createHash("sha256").update("gs-merge-policy-ref-policy-v1\0").update(JSON.stringify({
    guards: options.qualityGuards.map(({ name, revision }) => ({ name, revision }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    selectedRefPolicyNames: [...options.selectedRefPolicyNames].sort(),
    integrationPolicyNames: [...options.integrationPolicyNames].sort(),
  })).digest("hex");
}

export class MergePolicyError extends Error {
  readonly name = "MergePolicyError";
}
