import {
  commentPullRequestInputSchema,
  createPullRequestInputSchema,
  diffInputSchema,
  preparedPullRequestReviewSchema,
  pullRequestSelectionSchema,
  updatePullRequestInputSchema,
} from "@slop-lab/gs-client";
import { gitBlameRequestSchema, parseGitLineAttribution } from "@slop-lab/gs-blame";
import { parseDiffSnapshot } from "@slop-lab/gs-diff";
import { parsePullRequest, parsePullRequestList } from "@slop-lab/gs-pull-requests";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { z } from "zod";
import { dimCiStatusDto, parseReviewDto } from "./dto.js";
import { gitCiStatusSchema } from "@slop-lab/gs-client";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const scope = z.object({ projectId: identifier, repositoryId: identifier }).strict();
const selected = scope.extend({ pullRequestId: z.string().uuid() });
const versioned = selected.extend({ expectedVersion: z.number().int().positive() });

export const repositoryFeatureOperations: readonly Operation[] = [
  { name: "diff.read", description: "Inspect an immutable Git comparison", access: "read", parseInput: (value) => dimInput(diffInputSchema, value), parseOutput: parseDiffSnapshot },
  { name: "blame.line", description: "Read commit attribution for an exact file line", access: "read", parseInput: (value) => {
    const row = z.record(z.string(), z.unknown()).parse(value);
    const { projectId, repositoryId, ...input } = row;
    return { projectId: identifier.parse(projectId), repositoryId: identifier.parse(repositoryId), ...gitBlameRequestSchema.parse(input) };
  }, parseOutput: parseGitLineAttribution },
  { name: "ci.status", description: "Inspect required DIM CI evidence for an exact review", access: "read", parseInput: (value) => scope.extend({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(value), parseOutput: (value) => dimCiStatusDto(gitCiStatusSchema.parse(value)) },
  { name: "pull-requests.list", description: "List repository pull requests", access: "read", parseInput: (value) => scope.parse(value), parseOutput: parsePullRequestList },
  { name: "pull-requests.create", description: "Open a pull request from a candidate ref", access: "operator", parseInput: (value) => dimInput(createPullRequestInputSchema, value), parseOutput: parsePullRequest },
  { name: "pull-requests.detail", description: "Read a pull request and its revisions", access: "read", parseInput: (value) => selected.parse(value), parseOutput: parsePullRequest },
  { name: "pull-requests.update", description: "Edit, close or reopen a pull request", access: "operator", parseInput: (value) => dimInput(updatePullRequestInputSchema, value), parseOutput: parsePullRequest },
  { name: "pull-requests.refresh", description: "Inspect current heads and record a new revision", access: "operator", parseInput: (value) => versioned.parse(value), parseOutput: parsePullRequest },
  { name: "pull-requests.comment", description: "Discuss an exact pull request revision", access: "operator", parseInput: (value) => dimInput(commentPullRequestInputSchema, value), parseOutput: parsePullRequest },
  { name: "pull-requests.review", description: "Prepare review for the exact current revision", access: "reviewer", parseInput: (value) => versioned.parse(value), parseOutput: (value) => preparedPullRequestReviewSchema.parse(value) },
];

export const pullRequestWorkflowOperations: readonly Operation[] = [
  { name: "pull-requests.approve", description: "Approve the exact selected pull request revision", access: "reviewer", parseInput: (value) => dimInput(pullRequestSelectionSchema, value), parseOutput: parseReviewDto },
  { name: "pull-requests.revoke", description: "Revoke this reviewer's approval of the selected revision", access: "reviewer", parseInput: (value) => dimInput(pullRequestSelectionSchema, value), parseOutput: parseReviewDto },
  { name: "pull-requests.merge", description: "Promote the exact revision through human and DIM CI policy without approving it", access: "operator", parseInput: (value) => dimInput(pullRequestSelectionSchema, value), parseOutput: (value) => {
    const result = z.object({ pullRequest: z.unknown(), review: z.unknown(), promotion: z.unknown(), refreshPending: z.boolean() }).strict().parse(value);
    return { ...result, pullRequest: parsePullRequest(result.pullRequest), review: parseReviewDto(result.review) };
  } },
];

export function isPullRequestWorkflow(name: string): name is "pull-requests.approve" | "pull-requests.revoke" | "pull-requests.merge" {
  return pullRequestWorkflowOperations.some((operation) => operation.name === name);
}

export function repositoryFeatures(name: string): readonly string[] {
  if (name === "diff.read") return ["git-diff"];
  if (name === "blame.line") return ["git-blame"];
  if (name === "ci.status") return ["git-ci"];
  if (name === "pull-requests.comment") return ["git-pull-requests", "git-discussions", "git-diff"];
  if (name.startsWith("pull-requests.")) return ["git-pull-requests"];
  return [];
}

function dimInput<T>(schema: z.ZodType<T>, value: unknown): unknown {
  const parsedScope = scope.passthrough().parse(value);
  const row = z.record(z.string(), z.unknown()).parse(value);
  const { projectId: _projectId, ...portable } = row;
  const parsed = schema.parse({ ...portable, namespaceId: parsedScope.projectId });
  const { namespaceId: _namespaceId, ...rest } = z.record(z.string(), z.unknown()).parse(parsed);
  return { ...rest, ...parsedScope };
}
