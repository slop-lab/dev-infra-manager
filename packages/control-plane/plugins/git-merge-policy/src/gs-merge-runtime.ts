import type { MergeAuthorizationStore } from "@slop-lab/gs-merge-policy";
import {
  openMergePolicyFeature,
  type MergePolicyFeature,
  type MergePolicyService,
} from "@slop-lab/gs-merge-policy";
import {
  refUpdatePolicies,
  repositoryExtensionFactories,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { codeReviewService, type DimGsReviewRuntime } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import {
  mergeQualityGuards,
  toGsMergeQualityGuards,
  type MergeQualityGuard,
} from "./plugin-api.js";

export type DimGsMergeRuntime = {
  readonly review: DimGsReviewRuntime;
  readonly feature: MergePolicyFeature;
  readonly service: MergePolicyService;
};

export function createDimGsMergeRuntime(
  context: RepositoryExtensionContext,
  storage: { readonly statePath?: string; readonly authorizationStore?: MergeAuthorizationStore },
  guards: readonly MergeQualityGuard[] = mergeQualityGuards(context.extensions),
): DimGsMergeRuntime {
  const review = codeReviewService(context.extensions).gs(context);
  const feature = openMergePolicyFeature({
    ...storage,
    reviewFeature: review.feature,
    reader: review.adapter.reader,
    qualityGuards: toGsMergeQualityGuards(guards),
    selectedRefPolicyNames: refUpdatePolicies(context.extensions).map(({ name }) => name),
    integrationPolicyNames: repositoryExtensionFactories(context.extensions)
      .filter((factory) => factory.requiresMergeQualityGuard === false)
      .flatMap((factory) => factory.policyName === undefined ? [] : [factory.policyName]),
  });
  return { review, feature, service: feature.attach(review.adapter) };
}
