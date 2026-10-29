import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import type { PullRequestService as GsPullRequestService } from "@slop-lab/gs-pull-request-service";

export const pullRequestServiceKind = "dim.git-pull-requests.service";
export type PullRequestService = { gs(): GsPullRequestService };

export function pullRequestService(extensions: readonly ControlPlaneExtension[]): PullRequestService {
  const entry = extensions.find((candidate) => candidate.kind === pullRequestServiceKind && candidate.name === "default");
  if (entry === undefined || !("gs" in entry.value) || typeof entry.value.gs !== "function") {
    throw new Error("Pull request service is required");
  }
  return entry.value as PullRequestService;
}
