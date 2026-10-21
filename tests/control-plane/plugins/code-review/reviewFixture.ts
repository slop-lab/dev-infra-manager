import type { CodeReviewService } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";
import type { RunningService } from "../git-repositories/nativeRootImportFinalizeTypes.js";
import { reviewProposalRef } from "../git-ci/nativeBundleReviewFixture.js";
export * from "../git-ci/nativeBundleReviewFixture.js";
/** Inspect the human-review owner's immutable record, rather than the CI projection. */
export async function createBundleReview(service: RunningService, repositoryId = "root") {
  const extension = service.context.extensions.find(({ kind, name }) => kind === "dim.code-review.service" && name === "default");
  if (extension === undefined || !("create" in extension.value) || typeof extension.value.create !== "function") throw new Error("code review service is missing");
  const reviews = extension.value as CodeReviewService;
  return reviews.create(service.context, { projectId: "project-a", repositoryId, proposalRef: reviewProposalRef });
}
