import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { printReview, reviewOutputOptions, reviewSummary } from "../../../../packages/host/plugins/native-git/src/cli/review-output.js";
import type { ReviewDto } from "@slop-lab/dim-service-client-native-git";

const hash = "a".repeat(64), commit = "b".repeat(40);
const selection = { project: "local-alias", repository: "public" };
function review(): ReviewDto {
  return { schemaVersion: 1, reviewId: hash, projectId: "server-project", repositoryId: "public",
    proposalRef: "refs/heads/work/topic", protectedRef: "refs/heads/main", expectedProtectedHead: commit,
    candidateCommit: "c".repeat(40), candidateTree: "d".repeat(40), inputs: {},
    policyRevision: hash, requiredReviewRevision: hash, requiredReviewerIds: ["owner"],
    createdAt: "2026-11-09T00:00:00.000Z", status: "approved", staleReasons: [],
    changes: [], patch: "diff --git a/file b/file\n+CONTEXT_NOISE\n", approvals: [], revocations: [] };
}
afterEach(() => vi.restoreAllMocks());

it("bounds large evidence without exposing patches, path data or successful job records", () => {
  const base = review();
  const result = reviewSummary({ ...base, patch: "CONTEXT_NOISE\n".repeat(100_000),
    requiredReviewerIds: Array.from({ length: 256 }, (_, i) => `reviewer-${i}`),
    staleReasons: Array.from({ length: 256 }, () => "reason".repeat(160)),
    changes: Array.from({ length: 5_000 }, () => ({ status: "added", newPath: "LONG_PRIVATE_PATH".repeat(500), oldMode: "000000", newMode: "100644", oldObjectId: "0", newObjectId: commit })),
    approvals: Array.from({ length: 5_000 }, () => ({ approvalId: hash, reviewerId: "owner", approvedAt: base.createdAt })),
    ci: { schemaVersion: 1, reviewId: hash, candidateCommit: base.candidateCommit, expectedProtectedHead: commit,
      policy: "enabled", state: "pending", requiredJobs: Array.from({ length: 64 }, (_, i) => ({ name: `job-${i}`, kind: "ordinary-sysbox", status: "pending" })) },
  }, selection);
  const text = JSON.stringify(result);
  expect(Buffer.byteLength(text)).toBeLessThan(12_000);
  expect(text).not.toMatch(/CONTEXT_NOISE|LONG_PRIVATE_PATH|policyRevision/);
  expect(result.changes).toEqual({ total: 5_000, byStatus: { added: 5_000 } });
  expect(result.omitted).toMatchObject({ requiredReviewerIds: 248, missingReviewerIds: 248, staleReasons: 248, shortenedStaleReasons: 8 });
  expect(result.ci).toMatchObject({ state: "pending", total: 64, omitted: 56, counts: { pending: 64 } });
  expect(result.fullDetails).toContain("local-alias");
});

it("keeps human approval, stale evidence, revoked decisions and failed CI distinct", () => {
  const base = review();
  const result = reviewSummary({ ...base, status: "stale", staleReasons: ["protected head changed"],
    approvals: [{ approvalId: hash, reviewerId: "owner", approvedAt: base.createdAt }],
    revocations: [{ approvalId: hash, revokedAt: base.createdAt }],
    ci: { schemaVersion: 1, reviewId: hash, candidateCommit: base.candidateCommit, expectedProtectedHead: commit,
      policy: "enabled", state: "failed", requiredJobs: [
        ...Array.from({ length: 20 }, (_, i) => ({ name: `pass-${i}`, kind: "ordinary-sysbox", status: "succeeded" })),
        { name: "practical", kind: "qemu", status: "failed", executionId: "11111111-1111-4111-8111-111111111111" },
      ] },
  }, selection);
  expect(result).toMatchObject({ status: "stale", staleReasons: ["protected head changed"], missingReviewerIds: ["owner"], approvals: { total: 1, active: 0, revoked: 1 } });
  expect(result.ci?.requiredJobs).toEqual([{ name: "practical", kind: "qemu", status: "failed", executionId: "11111111-1111-4111-8111-111111111111" }]);
  expect(result.ci?.counts).toEqual({ succeeded: 20, failed: 1 });
  expect(reviewSummary(base, selection).ci).toBeNull();
});

it("prints one compact JSON record for agents and full evidence only on explicit request", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  printReview(review(), { agent: true }, selection);
  const text = String(output.mock.calls[0]![0]);
  expect(text).not.toContain("\n"); expect(JSON.parse(text)).not.toHaveProperty("patch");
  output.mockClear(); printReview(review(), { json: true }, selection);
  expect(JSON.parse(String(output.mock.calls[0]![0]))).not.toHaveProperty("patch");
  output.mockClear(); printReview(review(), { json: true, full: true }, selection);
  expect(JSON.parse(String(output.mock.calls[0]![0])).patch).toContain("CONTEXT_NOISE");
});

it.each([["--agent", "--full"], ["--full", "--agent"]])("rejects conflicting output modes before any operation: %s %s", async (...args) => {
  const action = vi.fn(), program = reviewOutputOptions(new Command().exitOverride().configureOutput({ writeErr() {} })).action(action);
  await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(/cannot be used/);
  expect(action).not.toHaveBeenCalled();
});
