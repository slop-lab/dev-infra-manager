import type { GitBlameRequest } from "@slop-lab/gs-blame";
import type { DiscussionAnchor } from "@slop-lab/gs-discussions";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";

export const gitClientCapabilities = [
  "git-review",
  "git-pull-requests",
  "git-discussions",
  "git-diff",
  "git-blame",
  "git-ci",
  "git-merge",
  "git-sync",
] as const;

export type GitClientCapability = (typeof gitClientCapabilities)[number];
export type PullRequestSelection = RepositorySelector & {
  readonly pullRequestId: string;
  readonly expectedVersion: number;
};

type Request<K extends string, I> = {
  readonly kind: K;
  readonly selector: RepositorySelector;
  readonly input: I;
  readonly responseLimitBytes: number;
};

export type GitServiceRequest =
  | Request<"diff.read", { readonly baseCommit: string; readonly headCommit: string }>
  | Request<"blame.line", GitBlameRequest>
  | Request<"ci.status", { readonly reviewId: string }>
  | Request<"pull-requests.list", Record<never, never>>
  | Request<"pull-requests.create", { readonly title: string; readonly body?: string; readonly sourceRef: string; readonly targetRef?: string }>
  | Request<"pull-requests.detail", { readonly pullRequestId: string }>
  | Request<"pull-requests.update", { readonly pullRequestId: string; readonly expectedVersion: number; readonly title?: string; readonly body?: string; readonly state?: "open" | "closed" }>
  | Request<"pull-requests.refresh", { readonly pullRequestId: string; readonly expectedVersion: number }>
  | Request<"pull-requests.comment", { readonly pullRequestId: string; readonly expectedVersion: number; readonly revisionId: string; readonly body: string; readonly anchor?: DiscussionAnchor }>
  | Request<"pull-requests.review", { readonly pullRequestId: string; readonly expectedVersion: number }>
  | Request<"reviews.list", Record<never, never>>
  | Request<"reviews.detail", { readonly reviewId: string }>
  | Request<"reviews.resolve", { readonly proposalRef: string; readonly protectedRef?: string }>
  | Request<"reviews.approve", { readonly reviewId: string; readonly requestId: string }>
  | Request<"reviews.revoke", { readonly reviewId: string; readonly approvalId: string }>
  | Request<"reviews.promote", { readonly reviewId: string }>
  | Request<"merges.prepare", { readonly sourceRef: string; readonly targetRef: string }>
  | Request<"sync", { readonly action: "fetch" | "merge" | "publish"; readonly protectedRef?: string }>;

export type GitServiceRequestInput = GitServiceRequest extends infer Entry
  ? Entry extends GitServiceRequest ? Omit<Entry, "responseLimitBytes"> : never
  : never;

export interface BoundedJsonTransport {
  request(request: GitServiceRequest): Promise<unknown>;
}
