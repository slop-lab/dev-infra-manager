import { z } from "zod";
import { gitBlameRequestSchema, parseGitLineAttribution } from "@slop-lab/gs-blame";
import { parseDiffSnapshot } from "@slop-lab/gs-diff";
import { discussionAnchorSchema } from "@slop-lab/gs-discussions";
import { parsePullRequest, parsePullRequestList } from "@slop-lab/gs-pull-requests";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { isNativeGitCandidateRef, isNativeGitOrdinaryCandidateRef } from "@slop-lab/dim-contracts-git";
import { reviewCiStatusSchema } from "@slop-lab/dim-contracts-ci/review-status";
const scope = z.object({ projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/), repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/) }).strict();
const selected = scope.extend({ pullRequestId: z.string().uuid() });
const versioned = selected.extend({ expectedVersion: z.number().int().positive() });
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const candidateRef = z.string().max(1024).refine(isNativeGitCandidateRef);
const branch = z.string().max(1024).refine((ref) => ref.startsWith("refs/heads/") && isNativeGitOrdinaryCandidateRef(ref));
export const repositoryFeatureOperations: readonly Operation[] = [
  { name: "diff.read", description: "Inspect an immutable Git comparison", access: "read", parseInput: v => scope.extend({ baseCommit: oid, headCommit: oid }).parse(v), parseOutput: parseDiffSnapshot },
  { name: "blame.line", description: "Read commit attribution for an exact file line", access: "read", parseInput: v => scope.extend(gitBlameRequestSchema.unwrap().shape).parse(v), parseOutput: parseGitLineAttribution },
  { name: "ci.status", description: "Inspect required DIM CI evidence for an exact review", access: "read", parseInput: v => scope.extend({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(v), parseOutput: v => reviewCiStatusSchema.parse(v) },
  { name: "pull-requests.list", description: "List repository pull requests", access: "read", parseInput: v => scope.parse(v), parseOutput: parsePullRequestList },
  { name: "pull-requests.create", description: "Open a pull request from a candidate ref", access: "operator", parseInput: v => scope.extend({ title: z.string().trim().min(1).max(240), body: z.string().max(3000).optional(), sourceRef: candidateRef, targetRef: branch.optional() }).parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.detail", description: "Read a pull request and its revisions", access: "read", parseInput: v => selected.parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.update", description: "Edit, close or reopen a pull request", access: "operator", parseInput: v => versioned.extend({ title: z.string().trim().min(1).max(240).optional(), body: z.string().max(3000).optional(), state: z.enum(["open", "closed"]).optional() }).parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.refresh", description: "Inspect current heads and record a new revision", access: "operator", parseInput: v => versioned.parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.comment", description: "Discuss an exact pull request revision", access: "operator", parseInput: v => versioned.extend({ revisionId: z.string().uuid(), body: z.string().trim().min(1).max(3000), anchor: discussionAnchorSchema.optional() }).parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.review", description: "Prepare review for the exact current revision", access: "reviewer", parseInput: v => versioned.parse(v), parseOutput: v => z.object({ pullRequestId: z.string().uuid(), revisionId: z.string().uuid(), review: z.object({ review: z.object({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough() }).passthrough() }).strict().parse(v) }
];
export function repositoryFeature(name: string): string | undefined {
  if (name === "diff.read") return "git-diff";
  if (name === "blame.line") return "git-blame";
  if (name === "ci.status") return "git-ci";
  if (name === "pull-requests.comment") return "git-discussions";
  if (name.startsWith("pull-requests.")) return "git-pull-requests";
  return undefined;
}
export function repositoryFeatureRequest(name: string, input: Record<string, unknown>): { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown } {
  const { projectId, repositoryId, pullRequestId, reviewId, ...body } = input;
  const base = `/v1/projects/${encodeURIComponent(String(projectId))}/repositories/${encodeURIComponent(String(repositoryId))}`;
  if (name === "diff.read") return { method: "POST", path: base + "/diff", body };
  if (name === "blame.line") return { method: "POST", path: base + "/blame", body };
  if (name === "ci.status") return { method: "GET", path: `${base}/reviews/${encodeURIComponent(String(reviewId))}/ci` };
  const path = base + "/pull-requests" + (pullRequestId === undefined ? "" : "/" + encodeURIComponent(String(pullRequestId)));
  if (name === "pull-requests.list" || name === "pull-requests.detail") return { method: "GET", path };
  if (name === "pull-requests.create") return { method: "POST", path, body };
  if (name === "pull-requests.update") return { method: "PATCH", path, body };
  const suffix = ({ "pull-requests.refresh": "refresh", "pull-requests.comment": "comments", "pull-requests.review": "review" } as Record<string, string>)[name];
  if (suffix === undefined) throw new Error("Unknown Git repository feature operation");
  return { method: "POST", path: path + "/" + suffix, body };
}
