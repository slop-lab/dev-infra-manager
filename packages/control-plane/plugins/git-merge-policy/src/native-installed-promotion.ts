import { readAuthoritativeNativeDecisions, readAuthoritativeNativeReviewEnvelope, nativeHumanReviewStaleReasons, reviewChangeMatchers } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { repositoryExtensionFactories, refUpdatePolicies, compareAndSwapProtectedRef, resolveAuthoritativeNativeRepositoryTarget, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { assertRequiredMergeQualityGuards, type MergeQualityGuard } from "./plugin-api.js";
import { MergeAuthorizationStore, type MergeAuthorization } from "./state.js";
export type NativeInstalledPromotionHooks = { readonly afterIntent?: () => void | Promise<void>; readonly afterCompareAndSwap?: () => void | Promise<void> };
export type NativeInstalledPromotionContext = { readonly repository: RepositoryExtensionContext; readonly store: MergeAuthorizationStore; readonly guards: readonly MergeQualityGuard[]; readonly hooks?: NativeInstalledPromotionHooks };
export type NativeInstalledPromotionResult = { readonly schemaVersion: 1; readonly outcome: "promoted" | "already-current"; readonly reviewId: string; readonly protectedRef: string; readonly expectedProtectedHead: string; readonly candidateCommit: string; readonly candidateTree: string; readonly sequence: number };
export async function promoteInstalledNativeReview(context: NativeInstalledPromotionContext, projectId: string, repositoryId: string, reviewId: string): Promise<NativeInstalledPromotionResult> {
  const initial = await resolveAuthoritativeNativeRepositoryTarget(context.repository.runtime, { projectId, repositoryId });
  const envelope = await readAuthoritativeNativeReviewEnvelope(initial.repository, reviewId);
  if (!envelope || envelope.review.projectId !== projectId || envelope.review.repositoryId !== repositoryId) throw new Error("review was not found");
  const { review } = envelope;
  const target = await resolveAuthoritativeNativeRepositoryTarget(context.repository.runtime, { projectId, repositoryId, protectedRef: review.protectedRef });
  const previous = context.store.read().find((entry) => entry.authorization.projectId === projectId && entry.authorization.repositoryId === repositoryId && entry.authorization.reviewId === reviewId && entry.sequence !== undefined);
  if (previous && target.currentHead.commit === previous.authorization.candidateCommit && review.candidateCommit === previous.authorization.candidateCommit && review.candidateTree === previous.authorization.candidateTree) return result("already-current", previous.authorization, previous.sequence!);
  if ((await nativeHumanReviewStaleReasons({ ...context.repository.runtime, reviewChangeMatchers: reviewChangeMatchers(context.repository.extensions) }, target, review)).length) throw new Error("review security tuple is stale");
  if (envelope.policyDigest !== target.imported.policyDigest) throw new Error("review policy digest is stale");
  const decisions = await readAuthoritativeNativeDecisions(target.repository, reviewId);
  const approvals = [...decisions.activeApprovals].sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
  if (JSON.stringify(approvals.map(({ reviewerId }) => reviewerId)) !== JSON.stringify(review.requiredReviewerIds)) throw new Error("human approval evidence is incomplete");
  assertRequiredMergeQualityGuards(target.imported.policy.extensions, envelope.attachments, context.guards, refUpdatePolicies(context.repository.extensions).map(({ name }) => name),
    repositoryExtensionFactories(context.repository.extensions).filter((factory) => factory.requiresMergeQualityGuard === false).flatMap((factory) => factory.policyName === undefined ? [] : [factory.policyName]));
  const attachments = [];
  for (const guard of context.guards) attachments.push(...await guard.check({ projectId, repositoryId, reviewId, repository: target.repository,
    candidateCommit: review.candidateCommit, candidateTree: review.candidateTree, expectedProtectedHead: review.expectedProtectedHead, policyDigest: envelope.policyDigest, attachments: envelope.attachments }));
  attachments.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const authorization: MergeAuthorization = { projectId, repositoryId, reviewId, generationId: context.repository.runtime.expectedGenerationId,
    envelopeId: envelope.envelopeId, policyDigest: envelope.policyDigest, protectedRef: review.protectedRef, proposalRef: review.proposalRef,
    expectedCommit: review.expectedProtectedHead, candidateCommit: review.candidateCommit, candidateTree: review.candidateTree,
    approvals: approvals.map(({ reviewerId, recordDigest }) => ({ reviewerId, recordDigest })), attachments };
  const prepared = context.store.prepare(authorization);
  await context.hooks?.afterIntent?.();
  const receipt = await compareAndSwapProtectedRef(context.repository, { projectId, repositoryId, protectedRef: review.protectedRef, proposalRef: authorization.proposalRef,
    expectedCommit: authorization.expectedCommit, candidateCommit: authorization.candidateCommit, candidateTree: authorization.candidateTree,
    authorizationId: prepared.authorizationId, evidenceDigest: prepared.evidenceDigest });
  await context.hooks?.afterCompareAndSwap?.();
  context.store.finalize(prepared.authorizationId, receipt.sequence);
  return result(receipt.outcome, authorization, receipt.sequence);
}
function result(outcome: NativeInstalledPromotionResult["outcome"], authorization: MergeAuthorization, sequence: number): NativeInstalledPromotionResult {
  return { schemaVersion: 1, outcome, reviewId: authorization.reviewId, protectedRef: authorization.protectedRef,
    expectedProtectedHead: authorization.expectedCommit, candidateCommit: authorization.candidateCommit, candidateTree: authorization.candidateTree, sequence };
}
