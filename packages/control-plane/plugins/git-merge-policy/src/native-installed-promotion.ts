import type { MergePromotionHooks, MergePromotionResult } from "@slop-lab/gs-merge-policy";
import type { RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { MergeQualityGuard } from "./plugin-api.js";
import type { MergeAuthorizationStore } from "./state.js";
import { createDimGsMergeRuntime } from "./gs-merge-runtime.js";

export type NativeInstalledPromotionHooks = MergePromotionHooks;
export type NativeInstalledPromotionResult = MergePromotionResult;
export type NativeInstalledPromotionContext = {
  readonly repository: RepositoryExtensionContext;
  readonly store: MergeAuthorizationStore;
  readonly guards: readonly MergeQualityGuard[];
  readonly hooks?: NativeInstalledPromotionHooks;
};

export async function promoteInstalledNativeReview(
  context: NativeInstalledPromotionContext,
  projectId: string,
  repositoryId: string,
  reviewId: string,
): Promise<NativeInstalledPromotionResult> {
  const runtime = createDimGsMergeRuntime(
    context.repository,
    { authorizationStore: context.store },
    context.guards,
  );
  try {
    return await runtime.review.adapter.withBorrowedMutation({
      namespaceId: projectId,
      repositoryId,
    }, (access) => runtime.feature.promoteInTransaction(access, {
      namespaceId: projectId,
      repositoryId,
      reviewId,
    }, context.hooks));
  } finally {
    runtime.feature.close();
  }
}
