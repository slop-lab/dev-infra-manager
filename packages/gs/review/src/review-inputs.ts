import { isDeepStrictEqual } from "node:util";
import type { RepositoryAuthority } from "@slop-lab/gs-repository-service";
import type { ReviewIdentity } from "@slop-lab/gs-review-contracts";

export async function assertReviewInputsCurrent(input: {
  readonly authority: RepositoryAuthority;
  readonly review: Pick<ReviewIdentity,
    "namespaceId" | "repositoryId" | "candidateCommit" | "candidateTree" | "inputs">;
}): Promise<void> {
  const primary = input.review.inputs[input.review.repositoryId];
  if (!isDeepStrictEqual(primary, {
    commit: input.review.candidateCommit,
    tree: input.review.candidateTree,
  })) throw new ReviewInputsError("review primary repository snapshot is invalid");
  for (const [repositoryId, snapshot] of Object.entries(input.review.inputs)) {
    if (repositoryId === input.review.repositoryId) continue;
    const target = await input.authority.resolve({ namespaceId: input.review.namespaceId, repositoryId });
    if (target.head.commit !== snapshot.commit || target.head.tree !== snapshot.tree) {
      throw new ReviewInputsError("review repository inputs changed");
    }
  }
}

export class ReviewInputsError extends Error {
  readonly name = "ReviewInputsError";
}
