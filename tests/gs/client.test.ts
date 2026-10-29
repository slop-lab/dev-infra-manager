import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitClientCapabilityError,
  createGitServiceClient,
  type BoundedJsonTransport,
  type GitServiceRequest,
} from "../../packages/gs/client/src/index.js";

const selector = { namespaceId: "example", repositoryId: "application" } as const;
const baseCommit = "a".repeat(40);
const headCommit = "b".repeat(40);

describe("portable Git service client", () => {
  it("sends a bounded namespace request and parses the external diff once", async () => {
    // Given
    const requests: GitServiceRequest[] = [];
    const transport: BoundedJsonTransport = {
      async request(request) {
        requests.push(request);
        return { baseCommit, headCommit, files: [] };
      },
    };
    const client = createGitServiceClient({ transport, capabilities: ["git-diff"] });

    // When
    const diff = await client.readDiff({ ...selector, baseCommit, headCommit });

    // Then
    expect(diff).toEqual({ baseCommit, headCommit, files: [] });
    expect(requests).toEqual([{
      kind: "diff.read",
      selector,
      input: { baseCommit, headCommit },
      responseLimitBytes: 8 * 1024 * 1024,
    }]);
  });

  it("rejects an unselected optional capability before crossing the transport", async () => {
    // Given
    let calls = 0;
    const client = createGitServiceClient({
      capabilities: ["git-diff"],
      transport: { async request() { calls += 1; return {}; } },
    });

    // When / Then
    await expect(client.blameLine({ ...selector, commit: headCommit, path: "README.md", line: 1 }))
      .rejects.toEqual(new GitClientCapabilityError("git-blame"));
    expect(calls).toBe(0);
  });

  it("requires immutable diff support before posting a line-capable discussion", async () => {
    // Given
    let calls = 0;
    const client = createGitServiceClient({
      capabilities: ["git-pull-requests", "git-discussions"],
      transport: { async request() { calls += 1; return {}; } },
    });

    // When / Then
    await expect(client.commentPullRequest({
      ...selector,
      pullRequestId: randomUUID(),
      expectedVersion: 1,
      revisionId: randomUUID(),
      body: "Inspect this line",
      anchor: { path: "README.md", side: "head", line: 1 },
    })).rejects.toEqual(new GitClientCapabilityError("git-diff"));
    expect(calls).toBe(0);
  });

  it("refuses a stale selected pull request revision without preparing a review", async () => {
    // Given
    const pullRequestId = randomUUID();
    const revisionId = randomUUID();
    const requests: GitServiceRequest[] = [];
    const transport: BoundedJsonTransport = {
      async request(request) {
        requests.push(request);
        return {
          schemaVersion: 1,
          id: pullRequestId,
          version: 2,
          title: "Candidate",
          body: "",
          sourceRef: "refs/heads/feature",
          targetRef: "refs/heads/main",
          state: "open",
          actorId: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          revisions: [{ id: revisionId, sourceCommit: headCommit, targetCommit: baseCommit, createdAt: "2026-01-01T00:00:00.000Z" }],
          comments: [],
        };
      },
    };
    const client = createGitServiceClient({ transport, capabilities: ["git-pull-requests", "git-review"] });

    // When / Then
    await expect(client.approvePullRequest({ ...selector, pullRequestId, expectedVersion: 1, revisionId }))
      .rejects.toMatchObject({ code: "stale" });
    expect(requests.map((request) => request.kind)).toEqual(["pull-requests.detail"]);
  });

  it("keeps sync as an independently selected Git capability", async () => {
    // Given
    const requests: GitServiceRequest[] = [];
    const client = createGitServiceClient({
      capabilities: ["git-sync"],
      transport: {
        async request(request) {
          requests.push(request);
          return { schemaVersion: 1, outcome: "published", sourceCommit: headCommit, targetRef: "refs/heads/main" };
        },
      },
    });

    // When
    const result = await client.sync({ ...selector, action: "publish", protectedRef: "refs/heads/main" });

    // Then
    expect(result).toMatchObject({ outcome: "published", sourceCommit: headCommit });
    expect(requests[0]).toMatchObject({ kind: "sync", selector, input: { action: "publish", protectedRef: "refs/heads/main" } });
  });

  it("preserves the canonical nested review envelope returned by the PR service", async () => {
    // Given
    const pullRequestId = randomUUID();
    const revisionId = randomUUID();
    const reviewId = "c".repeat(64);
    const response = preparedReviewResponse(pullRequestId, revisionId, reviewId);
    const client = createGitServiceClient({
      capabilities: ["git-pull-requests", "git-review"],
      transport: { async request() { return response; } },
    });

    // When
    const result = await client.preparePullRequestReview({ ...selector, pullRequestId, expectedVersion: 1 });

    // Then
    expect(result).toEqual(response);
  });

  it("parses provider-neutral CI checks without DIM generation or execution fields", async () => {
    // Given
    const reviewId = "c".repeat(64);
    const response = {
      schemaVersion: 1,
      reviewId,
      candidateCommit: headCommit,
      expectedProtectedHead: baseCommit,
      policy: "enabled",
      state: "succeeded",
      requiredChecks: [{ name: "test", provider: "ordinary-sysbox", status: "succeeded", runId: randomUUID() }],
    };
    const client = createGitServiceClient({
      capabilities: ["git-ci"],
      transport: { async request() { return response; } },
    });

    // When
    const result = await client.readCiStatus({ ...selector, reviewId });

    // Then
    expect(result).toEqual(response);
    expect(JSON.stringify(result)).not.toMatch(/generationId|executionId|requiredJobs|kind/);
  });
});

function preparedReviewResponse(pullRequestId: string, revisionId: string, reviewId: string) {
  return {
    pullRequestId,
    revisionId,
    review: {
      schemaVersion: 1,
      envelopeId: "d".repeat(64),
      policyDigest: "e".repeat(64),
      attachments: [],
      review: {
        schemaVersion: 1,
        namespaceId: selector.namespaceId,
        repositoryId: selector.repositoryId,
        inputs: { [selector.repositoryId]: { commit: "a".repeat(40), tree: "b".repeat(40) } },
        protectedRef: "refs/heads/main",
        proposalRef: "refs/heads/feature",
        expectedProtectedHead: "a".repeat(40),
        candidateCommit: "a".repeat(40),
        candidateTree: "b".repeat(40),
        policyRevision: "f".repeat(64),
        requiredReviewRevision: "1".repeat(64),
        requiredReviewerIds: [],
        changes: [],
        patch: "",
        patchBytes: "",
        reviewId,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}
