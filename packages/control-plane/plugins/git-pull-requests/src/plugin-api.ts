import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import type { RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { DiscussionComment } from "@slop-lab/git-discussions";
import type { PullRequest } from "@slop-lab/git-pull-requests";
export const pullRequestServiceKind = "dim.git-pull-requests.service";
export type PullRequestScope = { readonly projectId: string; readonly repositoryId: string };
/** Trusted consumers authorize repository scope and hold its mutation queue. */
export type PullRequestService = {
  read(context: RepositoryExtensionContext, scope: PullRequestScope, id: string): Promise<PullRequest | undefined>;
  appendComment(context: RepositoryExtensionContext, scope: PullRequestScope, id: string, expectedVersion: number, comment: DiscussionComment): Promise<PullRequest>;
};
export function pullRequestService(extensions: readonly ControlPlaneExtension[]): PullRequestService {
  const entry = extensions.find((entry) => entry.kind === pullRequestServiceKind && entry.name === "default");
  if (entry === undefined || !("read" in entry.value) || typeof entry.value.read !== "function" || !("appendComment" in entry.value) || typeof entry.value.appendComment !== "function") throw new Error("Pull request service is required");
  return entry.value as PullRequestService;
}
