import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { parseGitReview } from "../../packages/gs/client/src/index.js";
import { createReviewEnvelope } from "../../packages/gs/review-contracts/src/index.js";
import { encodeDimLegacyReviewEnvelope } from "../../packages/gs/review-contracts/src/dim-legacy-codec.js";
import { dimCiStatusDto, reviewDto } from "../../packages/service-clients/native-git/src/dto.js";
import { decodeDimCiStatus, decodeDimReviewDetail } from "../../packages/service-clients/native-git/src/wire-codec.js";

it("decodes the private DIM review wire into the neutral client before presentation", () => {
  // Given
  const envelope = neutralEnvelope();
  const wire = {
    ...encodeDimLegacyReviewEnvelope(envelope),
    status: "pending",
    staleReasons: [],
    approvals: [],
    revocations: [],
  };

  // When
  const result = reviewDto(parseGitReview(decodeDimReviewDetail(wire)));

  // Then
  expect(result).toMatchObject({ projectId: "project", repositoryId: "main", reviewId: envelope.review.reviewId });
  expect(result).not.toHaveProperty("namespaceId");
  expect(JSON.stringify(result)).not.toMatch(/patchBytes|pathBytes|password|recordDigest|native-main|workspaceId/);
});

it("round-trips legacy DIM CI jobs through provider-neutral client checks", () => {
  // Given
  const executionId = randomUUID();
  const wire = {
    schemaVersion: 1,
    reviewId: "a".repeat(64),
    generationId: "b".repeat(64),
    candidateCommit: "c".repeat(40),
    expectedProtectedHead: "d".repeat(40),
    policy: "enabled",
    state: "succeeded",
    requiredJobs: [{ name: "test", kind: "ordinary-sysbox", status: "succeeded", executionId }],
  };

  // When
  const neutral = decodeDimCiStatus(wire);
  const result = dimCiStatusDto(neutral);

  // Then
  expect(neutral).toMatchObject({ requiredChecks: [{ name: "test", provider: "ordinary-sysbox", runId: executionId }] });
  expect(JSON.stringify(neutral)).not.toMatch(/generationId|executionId|requiredJobs|kind/);
  expect(result).toMatchObject({ requiredJobs: [{ name: "test", kind: "ordinary-sysbox", executionId }] });
});

function neutralEnvelope() {
  const candidateCommit = "c".repeat(40);
  const candidateTree = "d".repeat(40);
  return createReviewEnvelope({
    identity: {
      schemaVersion: 1,
      namespaceId: "project",
      repositoryId: "main",
      inputs: { main: { commit: candidateCommit, tree: candidateTree } },
      protectedRef: "refs/heads/main",
      proposalRef: "refs/heads/feature",
      expectedProtectedHead: "e".repeat(40),
      candidateCommit,
      candidateTree,
      policyRevision: "f".repeat(64),
      requiredReviewRevision: "1".repeat(64),
      requiredReviewerIds: [],
      changes: [],
      patch: "",
      patchBytes: "",
    },
    policyDigest: "2".repeat(64),
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
