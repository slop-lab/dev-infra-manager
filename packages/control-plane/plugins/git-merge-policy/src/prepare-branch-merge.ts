import {
  prepareBranchMerge as prepareGsBranchMerge,
  type PreparedBranchMerge,
} from "@slop-lab/gs-merge-policy";
import type { RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { codeReviewService } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";

export type { PreparedBranchMerge } from "@slop-lab/gs-merge-policy";

export function prepareBranchMerge(
  context: RepositoryExtensionContext,
  selector: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly sourceRef: string;
    readonly targetRef: string;
  },
): Promise<PreparedBranchMerge> {
  const review = codeReviewService(context.extensions).gs(context);
  return review.adapter.withBorrowedMutation({
    namespaceId: selector.projectId,
    repositoryId: selector.repositoryId,
    protectedRef: selector.targetRef,
  }, (access) => prepareGsBranchMerge({
    access,
    review: review.service,
    gitExecutable: context.runtime.gitExecutable,
    gitIdentity: context.runtime.gitIdentity,
    sourceRef: selector.sourceRef,
    targetRef: selector.targetRef,
    signal: context.signal,
  }));
}
