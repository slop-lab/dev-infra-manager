import { expect, it } from "vitest";
import {
  createAuthoritativeNativeReviewEnvelope,
  reviewedCandidate,
  reviewRequestSchema,
} from "../../../packages/gs/review-contracts/src/index.js";
import { codeReviewPolicySectionOwner } from "../../../packages/gs/review/src/index.js";
import { mergePolicySectionOwner } from "../../../packages/gs/merge-policy/src/index.js";

it("exposes authorization-enforced owners for review and merge policy sections", () => {
  // Given
  const reviewPolicy = { requiredReviewerIds: [], pathReviewerRules: [], changeReviewerRules: [] };

  // When
  const parsedReview = codeReviewPolicySectionOwner.parse(reviewPolicy);
  const parsedMerge = mergePolicySectionOwner.parse({});

  // Then
  expect(codeReviewPolicySectionOwner).toMatchObject({ sectionName: "code-review", enforcement: "authorization" });
  expect(mergePolicySectionOwner).toMatchObject({ sectionName: "merge-policy", enforcement: "authorization" });
  expect(parsedReview).toEqual(reviewPolicy);
  expect(parsedMerge).toEqual({});
});

it("keeps the portable review request limited to neutral selectors and an optional requester", () => {
  // Given
  const request = {
    namespaceId: "tenant",
    repositoryId: "application",
    proposalRef: "refs/heads/candidate",
    requesterPrincipalId: "review-requester",
  };

  // When
  const parsed = reviewRequestSchema.parse(request);

  // Then
  expect(parsed).toEqual(request);
  expect(() => reviewRequestSchema.parse({ ...request, projectId: "dim-project" })).toThrow();
});

it("projects the existing persisted review bytes into a neutral reviewed candidate", () => {
  // Given
  const snapshot = { commit: "2".repeat(40), tree: "3".repeat(40) };
  const envelope = createAuthoritativeNativeReviewEnvelope({
    identity: {
      schemaVersion: 2,
      serviceId: "native-main",
      projectId: "tenant",
      repositoryId: "application",
      inputs: { application: snapshot },
      protectedRef: "refs/heads/main",
      proposalRef: "refs/heads/candidate",
      expectedProtectedHead: "1".repeat(40),
      candidateCommit: snapshot.commit,
      candidateTree: snapshot.tree,
      policyRevision: "4".repeat(64),
      requiredReviewRevision: "5".repeat(64),
      requiredReviewerIds: [],
      changes: [],
      patch: "",
      patchBytes: "",
    },
    policyDigest: "6".repeat(64),
    attachments: [],
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  // When
  const candidate = reviewedCandidate(envelope);

  // Then
  expect(candidate).toMatchObject({
    namespaceId: "tenant",
    repositoryId: "application",
    reviewId: envelope.review.reviewId,
    envelopeId: envelope.envelopeId,
    candidateCommit: snapshot.commit,
    candidateTree: snapshot.tree,
  });
});
