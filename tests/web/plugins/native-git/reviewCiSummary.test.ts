import { expect, it } from "vitest";
import { pullRequestMergeDisabled } from "../../../../packages/web/plugins/native-git/src/pull-requests.js";
import { reviewCiSummary } from "../../../../packages/web/plugins/native-git/src/review-ci.js";
import { parsePullRequest } from "@slop-lab/gs-pull-requests";

const common = {
  schemaVersion: 1 as const,
  reviewId: "a".repeat(64),
  generationId: "b".repeat(64),
  candidateCommit: "c".repeat(40),
  expectedProtectedHead: "d".repeat(40)
};

it("keeps missing, pending, failed and successful DIM CI states distinct", () => {
  expect(reviewCiSummary({ ...common, policy: "absent", state: "not-configured", requiredJobs: [] })).toContain("not configured");
  expect(reviewCiSummary({ ...common, policy: "enabled", state: "pending", requiredJobs: [{ name: "checks", kind: "ordinary-sysbox", status: "pending" }] })).toContain("required and pending");
  expect(reviewCiSummary({ ...common, policy: "enabled", state: "failed", requiredJobs: [{ name: "checks", kind: "ordinary-sysbox", status: "failed" }] })).toContain("failed");
  expect(reviewCiSummary({ ...common, policy: "enabled", state: "succeeded", requiredJobs: [{ name: "checks", kind: "ordinary-sysbox", status: "succeeded" }] })).toContain("succeeded");
});

it("does not equate human approval with DIM CI evidence", () => {
  expect(reviewCiSummary(undefined)).toContain("unavailable");
  expect(reviewCiSummary({ ...common, policy: "enabled", state: "not-required", requiredJobs: [] })).toContain("requires no jobs");
});

it("allows an operator to attempt composite merge before reviewer evidence exists", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const pullRequest = parsePullRequest({ schemaVersion: 1, id: "a22b5dfc-9108-4f40-9684-e68cc7000010", version: 1,
    title: "Operator merge", body: "", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main", state: "open",
    actorId: "operator", createdAt: now, updatedAt: now, comments: [], revisions: [{ id: "a22b5dfc-9108-4f40-9684-e68cc7000011",
      sourceCommit: "c".repeat(40), targetCommit: "d".repeat(40), createdAt: now }] });
  expect(pullRequestMergeDisabled(pullRequest, null)).toBe(false);
  expect(pullRequestMergeDisabled({ ...pullRequest, state: "closed" }, null)).toBe(true);
});
