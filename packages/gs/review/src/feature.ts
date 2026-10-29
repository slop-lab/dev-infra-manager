import { createHash } from "node:crypto";
import { repositoryBranchPolicy } from "@slop-lab/gs-repository-contracts";
import type {
  BorrowedRepositoryMutationAccess,
  PolicySectionOwner,
  RefUpdatePolicy,
  RepositoryAuthority,
  RepositoryTarget,
  RepositoryTargetSelector,
} from "@slop-lab/gs-repository-service";
import type {
  AuthoritativeNativeReviewEnvelope,
} from "@slop-lab/gs-review-contracts";
import { assertReviewChangeMatchers } from "./change-matchers.js";
import { readAuthoritativeNativeDecisions, type AuthoritativeNativeDecisions } from "./decision-store.js";
import { reviewStaleReasons } from "./freshness.js";
import { assertCurrentEpoch, createReviewInTransaction, type ReviewCreationInput } from "./review-engine.js";
import {
  readAuthoritativeNativeReviewEnvelope,
  readAuthoritativeNativeReviewEnvelopes,
} from "./review-store.js";
import { nativeHumanReviewStatus, type NativeHumanReviewStatus } from "./status.js";
import type { ReviewFeatureAttachment, ReviewFeatureOptions } from "./types.js";
import { ReviewService } from "./review-service.js";
import { codeReviewPolicySectionOwner } from "./policy.js";

export type ReviewSelection = {
  readonly target: RepositoryTarget;
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly staleReasons: readonly string[];
  readonly decisions: AuthoritativeNativeDecisions;
  readonly status: NativeHumanReviewStatus;
};

export class ReviewFeature {
  readonly refUpdatePolicy: RefUpdatePolicy;
  readonly policySectionOwner: PolicySectionOwner = codeReviewPolicySectionOwner;
  readonly #options: ReviewFeatureOptions;

  constructor(options: ReviewFeatureOptions) {
    assertReviewChangeMatchers(options.matchers);
    assertProviders(options.preparations);
    if (options.hooks?.promotionReady !== undefined
      && !/^[0-9a-f]{64}$/.test(options.promotionGateRevision ?? "")) {
      throw new ReviewFeatureError("promotion gate requires a stable revision");
    }
    this.#options = options;
    this.refUpdatePolicy = {
      name: "code-review",
      revision: featureRevision(options),
      authorize: (input) => this.#authorizeRefUpdate(input),
    };
  }

  attach(attachment: ReviewFeatureAttachment): ReviewService {
    return new ReviewService(this, attachment);
  }

  createInTransaction(
    access: BorrowedRepositoryMutationAccess,
    request: ReviewCreationInput,
    acceptPreparations = true,
  ): Promise<AuthoritativeNativeReviewEnvelope> {
    return createReviewInTransaction({
      options: this.#options,
      access,
      request,
      acceptPreparations,
    });
  }

  async inspectInTransaction(
    authority: RepositoryAuthority,
    selector: RepositoryTargetSelector,
    reviewId: string,
    principalId?: string,
    includePromotionGate = true,
  ): Promise<ReviewSelection> {
    assertCurrentEpoch(this.#options, authority.authorityEpoch);
    let target = await authority.resolve(selector);
    const envelope = await readAuthoritativeNativeReviewEnvelope(target.repositoryPath, reviewId);
    if (envelope === undefined || envelope.review.projectId !== selector.namespaceId
      || envelope.review.repositoryId !== selector.repositoryId) {
      throw new ReviewNotFoundError("review was not found");
    }
    if (target.head.protectedRef !== envelope.review.protectedRef) {
      target = await authority.resolve({ ...selector, protectedRef: envelope.review.protectedRef });
    }
    const staleReasons = [...await reviewStaleReasons({
      authority,
      reader: this.#options.reader,
      matchers: this.#options.matchers,
      preparations: this.#options.preparations,
      target,
      envelope,
      principalId: principalId ?? target.ownerPrincipalId,
      ...(this.#options.requirePreparationProviders === undefined ? {} : {
        requirePreparationProviders: this.#options.requirePreparationProviders,
      }),
    })];
    if (includePromotionGate && this.#options.hooks?.promotionReady !== undefined
      && !await this.#options.hooks.promotionReady({ target, envelope })) {
      staleReasons.push("review-preparation-pending");
    }
    const decisions = await readAuthoritativeNativeDecisions(target.repositoryPath, reviewId);
    await authority.assertCurrent(target);
    assertCurrentEpoch(this.#options, authority.authorityEpoch);
    const uniqueReasons = [...new Set(staleReasons)];
    return {
      target,
      envelope,
      staleReasons: uniqueReasons,
      decisions,
      status: nativeHumanReviewStatus(envelope.review.requiredReviewerIds, uniqueReasons, decisions),
    };
  }

  staleReasons(
    authority: RepositoryAuthority,
    target: RepositoryTarget,
    envelope: AuthoritativeNativeReviewEnvelope,
    principalId?: string,
  ): Promise<readonly string[]> {
    return reviewStaleReasons({
      authority,
      reader: this.#options.reader,
      matchers: this.#options.matchers,
      preparations: this.#options.preparations,
      target,
      envelope,
      principalId: principalId ?? target.ownerPrincipalId,
      ...(this.#options.requirePreparationProviders === undefined ? {} : {
        requirePreparationProviders: this.#options.requirePreparationProviders,
      }),
    });
  }

  async #authorizeRefUpdate(input: Parameters<RefUpdatePolicy["authorize"]>[0]): Promise<void> {
    if (!repositoryBranchPolicy(input.policy, input.target.head.protectedRef).review) return;
    const authority = input.authority;
    const target = await authority.resolve({
      namespaceId: input.change.namespaceId,
      repositoryId: input.change.repositoryId,
      protectedRef: input.target.head.protectedRef,
    });
    assertTargetProof(input.target, target);
    const envelopes = await readAuthoritativeNativeReviewEnvelopes(target.repositoryPath);
    for (const envelope of envelopes) {
      const { review } = envelope;
      if (review.projectId !== input.change.namespaceId || review.repositoryId !== input.change.repositoryId
        || review.proposalRef !== input.change.proposalRef || review.protectedRef !== target.head.protectedRef
        || review.expectedProtectedHead !== input.change.expectedCommit
        || review.candidateCommit !== input.change.candidateCommit
        || review.candidateTree !== input.change.candidateTree || envelope.policyDigest !== target.policyDigest) continue;
      const selected = await this.inspectInTransaction(authority, target.selector, review.reviewId);
      if (selected.staleReasons.length > 0) continue;
      const reviewers = selected.decisions.activeApprovals.map(({ reviewerId }) => reviewerId).sort();
      if (JSON.stringify(reviewers) === JSON.stringify(review.requiredReviewerIds)) return;
    }
    throw new ReviewAuthorizationError("protected ref requires a current review and every required human approval");
  }
}

export function createReviewFeature(options: ReviewFeatureOptions): ReviewFeature {
  return new ReviewFeature(options);
}

function assertTargetProof(
  expected: Parameters<RefUpdatePolicy["authorize"]>[0]["target"],
  current: RepositoryTarget,
): void {
  if (expected.repositoryPath !== current.repositoryPath || expected.incarnationId !== current.incarnationId
    || expected.authorityEpoch !== current.authorityEpoch || expected.policyDigest !== current.policyDigest
    || expected.ownerPrincipalId !== current.ownerPrincipalId || expected.refPolicyRevision !== current.refPolicyRevision
    || expected.head.sequence !== current.head.sequence || expected.head.commit !== current.head.commit
    || expected.head.tree !== current.head.tree || expected.head.protectedRef !== current.head.protectedRef) {
    throw new ReviewAuthorizationError("repository target changed during review authorization");
  }
}

function assertProviders(preparations: ReviewFeatureOptions["preparations"]): void {
  const names = new Set<string>();
  for (const preparation of preparations) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(preparation.name) || !/^[0-9a-f]{64}$/.test(preparation.revision)) {
      throw new ReviewFeatureError("invalid review preparation provider");
    }
    if (names.has(preparation.name)) throw new ReviewFeatureError(`duplicate review preparation '${preparation.name}'`);
    names.add(preparation.name);
  }
}

function featureRevision(options: ReviewFeatureOptions): string {
  return createHash("sha256").update("gs-code-review-ref-policy-v1\0").update(JSON.stringify({
    matchers: options.matchers.map(({ name, revision }) => ({ name, revision })).sort((left, right) => left.name.localeCompare(right.name)),
    preparations: options.preparations.map(({ name, revision }) => ({ name, revision })).sort((left, right) => left.name.localeCompare(right.name)),
    promotionGateRevision: options.promotionGateRevision ?? null,
    requirePreparationProviders: options.requirePreparationProviders ?? true,
  })).digest("hex");
}

export class ReviewFeatureError extends Error {
  readonly name = "ReviewFeatureError";
}

export class ReviewNotFoundError extends Error {
  readonly name = "ReviewNotFoundError";
}

export class ReviewAuthorizationError extends Error {
  readonly name = "ReviewAuthorizationError";
}
