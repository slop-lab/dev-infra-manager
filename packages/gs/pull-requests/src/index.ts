import { z } from "zod";
import {
  appendDiscussionComment,
  discussionListSchema,
  type DiscussionComment,
} from "@slop-lab/gs-discussions";

const identity = z.string().min(1).max(256).refine(value => !value.includes("\0"));
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const gitRef = z.string().min(1).max(1024).refine((ref) => {
  const prefix = ref.startsWith("refs/heads/") ? "refs/heads/"
    : ref.startsWith("refs/tags/") ? "refs/tags/" : undefined;
  if (prefix === undefined) return false;
  const suffix = ref.slice(prefix.length);
  return suffix.length > 0 && !/[\x00-\x20\x7f~^:?*[\\\]]/.test(suffix)
    && !suffix.includes("..") && !suffix.includes("@{") && !suffix.includes("//")
    && suffix.split("/").every((part) => part.length > 0 && !part.startsWith(".")
      && !part.endsWith(".") && !part.endsWith(".lock"));
});
export const revisionSchema = z.object({
  id: identity,
  sourceCommit: objectId,
  targetCommit: objectId,
  createdAt: z.string().datetime()
}).strict().readonly();

export const pullRequestSchema = z.object({
  schemaVersion: z.literal(1),
  id: identity,
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  body: z.string().max(3000),
  sourceRef: gitRef,
  targetRef: gitRef.refine((ref) => ref.startsWith("refs/heads/")),
  state: z.enum(["open", "closed", "merged"]),
  actorId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revisions: z.array(revisionSchema).min(1).max(10000)
    .refine(items => new Set(items.map(item => item.id)).size === items.length).readonly(),
  comments: discussionListSchema
}).strict().readonly();

export type PullRequest = z.infer<typeof pullRequestSchema>;
export type PullRequestRevision = z.infer<typeof revisionSchema>;
export class PullRequestConflict extends Error {
  override name = "PullRequestConflict";
}

export function assertVersion(pr: PullRequest, expectedVersion: number): void {
  if (pr.version !== expectedVersion) throw new PullRequestConflict("Pull request changed; refresh before retrying");
}
export function currentRevision(pr: PullRequest): PullRequestRevision {
  return pr.revisions[pr.revisions.length - 1]!;
}

export function updatePullRequest(pr: PullRequest, expectedVersion: number, patch: { readonly title?: string; readonly body?: string; readonly state?: "open" | "closed" }, now: string): PullRequest {
  assertVersion(pr, expectedVersion);
  if (pr.state === "merged") throw new PullRequestConflict("Merged pull requests cannot be changed");
  return pullRequestSchema.parse({ ...pr, ...patch, version: pr.version + 1, updatedAt: now });
}
export function appendRevision(pr: PullRequest, expectedVersion: number, revision: PullRequestRevision): PullRequest {
  assertVersion(pr, expectedVersion);
  if (pr.state !== "open") throw new PullRequestConflict("Pull request is not open");
  const previous = currentRevision(pr);
  if (previous.sourceCommit === revision.sourceCommit && previous.targetCommit === revision.targetCommit) return pr;
  return pullRequestSchema.parse({ ...pr, version: pr.version + 1, updatedAt: revision.createdAt, revisions: [...pr.revisions, revision] });
}
export function appendComment(pr: PullRequest, expectedVersion: number, comment: DiscussionComment): PullRequest {
  assertVersion(pr, expectedVersion);
  if (!pr.revisions.some((revision) => revision.id === comment.revisionId)) throw new PullRequestConflict("Comment revision does not belong to this pull request");
  return pullRequestSchema.parse({ ...pr, version: pr.version + 1, updatedAt: comment.createdAt, comments: appendDiscussionComment(pr.comments, comment) });
}
/** The adapter must first prove that the protected target contains this exact revision. */
export function markMerged(pr: PullRequest, expectedVersion: number, now: string): PullRequest {
  assertVersion(pr, expectedVersion);
  if (pr.state !== "open") throw new PullRequestConflict("Pull request is not open");
  return pullRequestSchema.parse({ ...pr, state: "merged", version: pr.version + 1, updatedAt: now });
}
export function parsePullRequest(value: unknown): PullRequest { return pullRequestSchema.parse(value); }
export function parsePullRequestList(value: unknown): readonly PullRequest[] { return z.array(pullRequestSchema).readonly().parse(value); }
