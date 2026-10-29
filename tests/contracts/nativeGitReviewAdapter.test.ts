import { expect, it } from "vitest";
import { reviewDto } from "../../packages/service-clients/native-git/src/dto.js";

it("maps the private DIM project and generation wire fields to the public review DTO", () => {
  // Given
  const reviewId = "a".repeat(64);
  const candidateCommit = "b".repeat(40);
  const expectedProtectedHead = "c".repeat(40);
  const wire = {
    schemaVersion: 3,
    review: {
      schemaVersion: 2,
      projectId: "project",
      repositoryId: "main",
      protectedRef: "refs/heads/main",
      proposalRef: "refs/heads/feature",
      expectedProtectedHead,
      inputs: { main: { commit: candidateCommit, tree: "d".repeat(40) } },
      candidateCommit,
      candidateTree: "d".repeat(40),
      policyRevision: "policy",
      requiredReviewRevision: "review",
      requiredReviewerIds: [],
      changes: [],
      patch: "",
      reviewId,
      createdAt: "2026-01-01T00:00:00.000Z",
      ci: {
        schemaVersion: 1,
        reviewId,
        generationId: "e".repeat(64),
        candidateCommit,
        expectedProtectedHead,
        policy: "absent",
        state: "not-configured",
        requiredJobs: [],
      },
    },
    status: "pending",
    staleReasons: [],
    approvals: [],
    revocations: [],
  };

  // When
  const result = reviewDto(wire);

  // Then
  expect(result).toMatchObject({ projectId: "project", repositoryId: "main", reviewId, ci: { state: "not-configured" } });
  expect(result).not.toHaveProperty("namespaceId");
  expect(result.ci).not.toHaveProperty("generationId");
  expect(JSON.stringify(result)).not.toMatch(/patchBytes|password|recordDigest/);
});
