import { isDeepStrictEqual } from "node:util";
import { resolveAuthoritativeNativeRepositoryTarget, type RepositoryRuntime } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { AuthoritativeNativeReviewIdentity } from "./authoritative-native-review-schema.js";
export async function assertReviewInputsCurrent(runtime: RepositoryRuntime, review: Pick<AuthoritativeNativeReviewIdentity, "projectId" | "repositoryId" | "candidateCommit" | "candidateTree" | "inputs">): Promise<void> {
  const primary = review.inputs[review.repositoryId];
  if (!isDeepStrictEqual(primary, { commit: review.candidateCommit, tree: review.candidateTree })) throw new Error("review primary repository snapshot is invalid");
  for (const [repositoryId, snapshot] of Object.entries(review.inputs)) {
    if (repositoryId === review.repositoryId) continue;
    const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: review.projectId, repositoryId });
    if (target.currentHead.commit !== snapshot.commit || target.currentHead.tree !== snapshot.tree) throw new Error("review repository inputs changed");
  }
}
