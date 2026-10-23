import { z } from "zod";
import { parseDiffSnapshot } from "@slop-lab/git-diff";
import { anchorSchema, parsePullRequest, parsePullRequestList } from "@slop-lab/git-pull-requests";
import type { Operation } from "@slop-lab/dim-contracts-operations";
const scope = z.object({ projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/), repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/) }).strict();
const selected = scope.extend({ pullRequestId: z.string().uuid() });
const versioned = selected.extend({ expectedVersion: z.number().int().positive() });
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const branch = z.string().startsWith("refs/heads/").max(1024);
export const repositoryFeatureOperations: readonly Operation[] = [
  { name: "diff.read", description: "Inspect an immutable Git comparison", access: "read", parseInput: v => scope.extend({ baseCommit: oid, headCommit: oid }).parse(v), parseOutput: parseDiffSnapshot },
  { name: "blame.line", description: "Read commit attribution for an exact file line", access: "read", parseInput: v => scope.extend({ commit: oid, path: z.string().min(1).max(4096), line: z.number().int().positive() }).parse(v), parseOutput: v => z.object({ commit: oid, path: z.string(), line: z.number().int().positive(), author: z.string(), summary: z.string() }).strict().parse(v) },
  { name: "pull-requests.list", description: "List repository pull requests", access: "read", parseInput: v => scope.parse(v), parseOutput: parsePullRequestList },
  { name: "pull-requests.create", description: "Open a pull request from a proposal", access: "operator", parseInput: v => scope.extend({ title: z.string().trim().min(1).max(240), body: z.string().max(3000).optional(), sourceRef: branch, targetRef: branch.optional() }).parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.detail", description: "Read a pull request and its revisions", access: "read", parseInput: v => selected.parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.update", description: "Edit, close or reopen a pull request", access: "operator", parseInput: v => versioned.extend({ title: z.string().trim().min(1).max(240).optional(), body: z.string().max(3000).optional(), state: z.enum(["open", "closed"]).optional() }).parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.refresh", description: "Inspect current heads and record a new revision", access: "operator", parseInput: v => versioned.parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.comment", description: "Discuss an exact pull request revision", access: "operator", parseInput: v => versioned.extend({ revisionId: z.string().uuid(), body: z.string().trim().min(1).max(3000), anchor: anchorSchema.optional() }).parse(v), parseOutput: parsePullRequest },
  { name: "pull-requests.review", description: "Prepare review for the exact current revision", access: "reviewer", parseInput: v => versioned.parse(v), parseOutput: v => z.object({ pullRequestId: z.string().uuid(), revisionId: z.string().uuid(), review: z.object({ review: z.object({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough() }).passthrough() }).strict().parse(v) }
];
export function repositoryFeature(name: string): string | undefined {
  if (name === "diff.read") return "git-diff";
  if (name === "blame.line") return "git-blame";
  if (name === "pull-requests.comment") return "git-discussions";
  if (name.startsWith("pull-requests.")) return "git-pull-requests";
  return undefined;
}
export function repositoryFeatureRequest(name: string, input: Record<string, unknown>): { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown } {
  const { projectId, repositoryId, pullRequestId, ...body } = input;
  const base = `/v1/projects/${encodeURIComponent(String(projectId))}/repositories/${encodeURIComponent(String(repositoryId))}`;
  if (name === "diff.read") return { method: "POST", path: base + "/diff", body };
  if (name === "blame.line") return { method: "POST", path: base + "/blame", body };
  const path = base + "/pull-requests" + (pullRequestId === undefined ? "" : "/" + encodeURIComponent(String(pullRequestId)));
  if (name === "pull-requests.list" || name === "pull-requests.detail") return { method: "GET", path };
  if (name === "pull-requests.create") return { method: "POST", path, body };
  if (name === "pull-requests.update") return { method: "PATCH", path, body };
  const suffix = ({ "pull-requests.refresh": "refresh", "pull-requests.comment": "comments", "pull-requests.review": "review" } as Record<string, string>)[name];
  if (suffix === undefined) throw new Error("Unknown Git repository feature operation");
  return { method: "POST", path: path + "/" + suffix, body };
}
