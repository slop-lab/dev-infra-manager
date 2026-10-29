import type { RepositoryMutationGate, RepositoryTargetSelector } from "@slop-lab/gs-repository-service";
import type { MergePolicyFeature, MergePromotionResult } from "./feature.js";

export class MergePolicyService {
  readonly #feature: MergePolicyFeature;
  readonly #mutationGate: RepositoryMutationGate;

  constructor(feature: MergePolicyFeature, mutationGate: RepositoryMutationGate) {
    this.#feature = feature;
    this.#mutationGate = mutationGate;
  }

  promote(input: RepositoryTargetSelector & { readonly reviewId: string }): Promise<MergePromotionResult> {
    return this.#mutationGate.mutate(input, (access) => this.#feature.promoteInTransaction(access, input));
  }

  close(): Promise<void> {
    this.#feature.close();
    return Promise.resolve();
  }
}
