import { z } from "zod";

const identity = z.string().min(1).max(256).refine(value => !value.includes("\0"));
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const revisionSchema = z.object({
  id: identity,
  sourceCommit: objectId,
  targetCommit: objectId,
  createdAt: z.string().datetime()
}).strict().readonly();

export const anchorSchema = z.object({
  path: z.string().min(1).max(4096).refine(path =>
    !path.includes("\0") && !path.startsWith("/") && !path.split("/").includes("..")),
  side: z.enum(["base", "head"]),
  line: z.number().int().positive()
}).strict().readonly();

export const commentSchema = z.object({
  id: identity,
  revisionId: identity,
  actorId: z.string().min(1),
  body: z.string().trim().min(1).max(3000),
  createdAt: z.string().datetime(),
  anchor: anchorSchema.optional()
}).strict().readonly();

export const pullRequestSchema = z.object({
  schemaVersion: z.literal(1),
  id: identity,
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  body: z.string().max(3000),
  sourceRef: z.string().min(1).max(1024),
  targetRef: z.string().min(1).max(1024),
  state: z.enum(["open", "closed", "merged"]),
  actorId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revisions: z.array(revisionSchema).min(1).max(10000)
    .refine(items => new Set(items.map(item => item.id)).size === items.length).readonly(),
  comments: z.array(commentSchema).max(10000)
    .refine(items => new Set(items.map(item => item.id)).size === items.length).readonly()
}).strict().readonly();

export type PullRequest = z.infer<typeof pullRequestSchema>;
export type PullRequestRevision = z.infer<typeof revisionSchema>;
export type PullRequestComment = z.infer<typeof commentSchema>;
export type DiffAnchor = z.infer<typeof anchorSchema>;
export class PullRequestConflict extends Error {
  override name = "PullRequestConflict";
}

export function assertVersion(pr: PullRequest, expectedVersion: number): void {
  if (pr.version !== expectedVersion) throw new PullRequestConflict("Pull request changed; refresh before retrying");
}
export function currentRevision(pr: PullRequest): PullRequestRevision {
  return pr.revisions[pr.revisions.length - 1]!;
}

export function commentIsOutdated(pr: PullRequest, comment: PullRequestComment): boolean {
  return comment.revisionId !== currentRevision(pr).id;
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
export function appendComment(pr: PullRequest, expectedVersion: number, comment: PullRequestComment): PullRequest {
  assertVersion(pr, expectedVersion);
  if (!pr.revisions.some((revision) => revision.id === comment.revisionId)) throw new PullRequestConflict("Comment revision does not belong to this pull request");
  return pullRequestSchema.parse({ ...pr, version: pr.version + 1, updatedAt: comment.createdAt, comments: [...pr.comments, comment] });
}
/** The adapter must first prove that the protected target contains this exact revision. */
export function markMerged(pr: PullRequest, expectedVersion: number, now: string): PullRequest {
  assertVersion(pr, expectedVersion);
  if (pr.state !== "open") throw new PullRequestConflict("Pull request is not open");
  return pullRequestSchema.parse({ ...pr, state: "merged", version: pr.version + 1, updatedAt: now });
}
export function parsePullRequest(value: unknown): PullRequest { return pullRequestSchema.parse(value); }
export function parsePullRequestList(value: unknown): readonly PullRequest[] { return z.array(pullRequestSchema).readonly().parse(value); }
