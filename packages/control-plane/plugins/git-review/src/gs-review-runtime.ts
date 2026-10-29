import { createHash } from "node:crypto";
import type {
  BorrowedRepositoryMutationAccess,
  BorrowedRepositoryMutationAuthority,
  RepositoryAuthority,
  RepositoryTarget,
  RepositoryTargetSelector,
} from "@slop-lab/gs-repository-service";
import {
  createGitRepositoryReadService,
  createReviewFeature,
  type ReviewFeature,
  type ReviewFeatureHooks,
  type ReviewPreparation as GsReviewPreparation,
  type ReviewService,
} from "@slop-lab/gs-review";
import {
  createGsRepositoryServiceAdapter,
  findFinalizedProtectedRef,
  readNativeProjectRegistrations,
  refUpdatePolicies,
  refUpdatePolicyRevision,
  resolveAuthoritativeNativeRepositoryTarget,
  assertAuthoritativeNativeRepositoryTargetCurrent,
  type AuthoritativeNativeRepositoryTarget,
  type GsRepositoryServiceAdapter,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { reviewChangeMatchers } from "./change-matchers.js";
import type { CodeReviewRuntime, ReviewPreparation } from "./plugin-api.js";

export type DimGsReviewRuntime = {
  readonly adapter: GsRepositoryServiceAdapter;
  readonly feature: ReviewFeature;
  readonly service: ReviewService;
};

export function createDimGsReviewRuntime(
  context: RepositoryExtensionContext,
  hooks: ReviewFeatureHooks = {},
): DimGsReviewRuntime {
  const adapter = createGsRepositoryServiceAdapter(context);
  const runtime: CodeReviewRuntime = {
    ...context.runtime,
    reviewPreparations: reviewPreparationsFromExtensions(context),
    reviewChangeMatchers: reviewChangeMatchers(context.extensions),
  };
  const feature = createReviewFeature({
    reader: adapter.reader,
    matchers: runtime.reviewChangeMatchers ?? [],
    preparations: toGsPreparations(runtime),
    currentAuthorityEpoch: () => context.runtime.expectedGenerationId,
    promotionGateRevision: createHash("sha256").update("dim-proposal-acceptance-gate-v1").digest("hex"),
    hooks,
  });
  return { adapter, feature, service: feature.attach(adapter) };
}

export async function createDetachedGsReviewExecution(
  runtime: CodeReviewRuntime,
  selector: RepositoryTargetSelector,
  hooks: ReviewFeatureHooks = {},
): Promise<{
  readonly feature: ReviewFeature;
  readonly access: BorrowedRepositoryMutationAccess;
}> {
  const proofs = new WeakMap<RepositoryTarget, AuthoritativeNativeRepositoryTarget>();
  const authority = createDetachedAuthority(runtime, proofs);
  const reader = createGitRepositoryReadService({
    runtime: { gitExecutable: runtime.gitExecutable },
    gitIdentity: runtime.gitIdentity,
  });
  const feature = createReviewFeature({
    reader,
    matchers: runtime.reviewChangeMatchers ?? reviewChangeMatchers([]),
    preparations: toGsPreparations(runtime),
    currentAuthorityEpoch: () => runtime.expectedGenerationId,
    requirePreparationProviders: false,
    hooks,
  });
  return {
    feature,
    access: { authority, target: await authority.resolve(selector) },
  };
}

export function toGsPreparations(runtime: CodeReviewRuntime): readonly GsReviewPreparation[] {
  return (runtime.reviewPreparations ?? []).map((preparation) => ({
    name: preparation.name,
    revision: preparation.revision ?? createHash("sha256")
      .update("dim-review-preparation-adapter-v1\0").update(preparation.name).digest("hex"),
    async prepare(input) {
      const target = await resolveAuthoritativeNativeRepositoryTarget(
        { ...runtime, authoritativeTargetProofs: new Map() },
        {
          projectId: input.request.namespaceId,
          repositoryId: input.request.repositoryId,
          ...(input.request.protectedRef === undefined ? {} : { protectedRef: input.request.protectedRef }),
        },
      );
      return preparation.prepare({
        runtime,
        selector: {
          projectId: input.request.namespaceId,
          repositoryId: input.request.repositoryId,
          proposalRef: input.request.proposalRef,
          ...(input.request.protectedRef === undefined ? {} : { protectedRef: input.request.protectedRef }),
        },
        target,
        evidence: input.evidence,
        identity: input.identity,
      });
    },
    ...(preparation.assertCurrent === undefined ? {} : {
      assertCurrent: (input: Parameters<NonNullable<GsReviewPreparation["assertCurrent"]>>[0]) =>
        preparation.assertCurrent?.({
          runtime,
          review: input.review,
          ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
        }) ?? Promise.resolve(),
    }),
    ...(preparation.accepted === undefined ? {} : {
      accepted: (input: Parameters<NonNullable<GsReviewPreparation["accepted"]>>[0]) =>
        preparation.accepted?.({
          runtime,
          envelope: input.envelope,
          ownerRequestId: input.ownerRequestId,
        }) ?? Promise.resolve(),
    }),
  }));
}

function reviewPreparationsFromExtensions(context: RepositoryExtensionContext): readonly ReviewPreparation[] {
  return context.extensions
    .filter((entry) => entry.kind === "dim.code-review.preparation")
    .map((entry) => {
      if (!isReviewPreparation(entry.value)) throw new DimGsReviewRuntimeError(`invalid review preparation: ${entry.name}`);
      return entry.value;
    });
}

function createDetachedAuthority(
  runtime: CodeReviewRuntime,
  proofs: WeakMap<RepositoryTarget, AuthoritativeNativeRepositoryTarget>,
): RepositoryAuthority & BorrowedRepositoryMutationAuthority {
  const authority = {
    authorityEpoch: runtime.expectedGenerationId,
    async resolve(selector: RepositoryTargetSelector): Promise<RepositoryTarget> {
      const proof = await resolveAuthoritativeNativeRepositoryTarget(
        { ...runtime, authoritativeTargetProofs: new Map() },
        {
          projectId: selector.namespaceId,
          repositoryId: selector.repositoryId,
          ...(selector.protectedRef === undefined ? {} : { protectedRef: selector.protectedRef }),
        },
      );
      const target = toGsTarget(runtime, proof);
      proofs.set(target, proof);
      return target;
    },
    async assertCurrent(target: RepositoryTarget): Promise<void> {
      const proof = proofs.get(target);
      if (proof === undefined) throw new DimGsReviewRuntimeError("detached target was not issued by this adapter");
      await assertAuthoritativeNativeRepositoryTargetCurrent({
        runtime: { ...runtime, authoritativeTargetProofs: new Map() },
        selector: {
          projectId: target.selector.namespaceId,
          repositoryId: target.selector.repositoryId,
          protectedRef: target.head.protectedRef,
        },
        target: proof,
      });
    },
    async list(namespace: { readonly namespaceId: string }): Promise<readonly RepositoryTarget[]> {
      const targets: RepositoryTarget[] = [];
      for (const selector of await authority.listSelectors(namespace)) targets.push(await authority.resolve(selector));
      return targets;
    },
    async listSelectors(namespace?: { readonly namespaceId: string }) {
      return readNativeProjectRegistrations(runtime.state)
        .filter((entry) => namespace === undefined || entry.projectId === namespace.namespaceId)
        .map((entry) => ({ namespaceId: entry.projectId, repositoryId: entry.repositoryId }));
    },
    async availability(selector: RepositoryTargetSelector) {
      if (!(await authority.listSelectors({ namespaceId: selector.namespaceId }))
        .some((entry) => entry.repositoryId === selector.repositoryId)) return { kind: "not-found" as const };
      return { kind: "available" as const, target: await authority.resolve(selector) };
    },
    findFinalized: (query: Parameters<RepositoryAuthority["findFinalized"]>[0]) =>
      findFinalizedProtectedRef(runtime, query),
    async promote() {
      throw new DimGsReviewRuntimeError("detached review execution cannot promote a protected ref");
    },
  };
  return authority;
}

function toGsTarget(runtime: CodeReviewRuntime, proof: AuthoritativeNativeRepositoryTarget): RepositoryTarget {
  return {
    selector: { namespaceId: proof.imported.projectId, repositoryId: proof.imported.repositoryId },
    repositoryPath: proof.repository,
    head: {
      sequence: proof.currentHead.sequence,
      protectedRef: proof.currentHead.protectedRef,
      commit: proof.currentHead.commit,
      tree: proof.currentHead.tree,
    },
    incarnationId: proof.imported.importNonce,
    authorityEpoch: runtime.expectedGenerationId,
    policyDigest: proof.imported.policyDigest,
    ownerPrincipalId: proof.imported.ownerHostId,
    refPolicyRevision: refUpdatePolicyRevision(proof.imported.policy, refUpdatePolicies([])),
    policy: proof.imported.policy,
  };
}

function isReviewPreparation(value: unknown): value is ReviewPreparation {
  return typeof value === "object" && value !== null
    && "name" in value && typeof value.name === "string"
    && "prepare" in value && typeof value.prepare === "function";
}

export class DimGsReviewRuntimeError extends Error {
  readonly name = "DimGsReviewRuntimeError";
}
