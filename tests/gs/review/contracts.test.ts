import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createReviewEnvelope,
  reviewedCandidate,
  reviewRequestSchema,
} from "../../../packages/gs/review-contracts/src/index.js";
import {
  decodeDimLegacyReviewEnvelope,
  encodeDimLegacyReviewEnvelope,
} from "../../../packages/gs/review-contracts/src/dim-legacy-codec.js";
import { codeReviewPolicySectionOwner } from "../../../packages/gs/review/src/index.js";
import { mergePolicySectionOwner } from "../../../packages/gs/merge-policy/src/index.js";

it("keeps the root review SDK neutral and publishes DIM persistence only through an explicit codec", async () => {
  // Given
  const contracts: Readonly<Record<string, unknown>> = await import("../../../packages/gs/review-contracts/src/index.js");
  const manifest: unknown = JSON.parse(await readFile(
    new URL("../../../packages/gs/review-contracts/package.json", import.meta.url), "utf8",
  ));

  // When
  const exports = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "exports") : undefined;

  // Then
  expect(Reflect.get(contracts, "reviewSchema")).toBeDefined();
  expect(Reflect.get(contracts, "createReviewEnvelope")).toBeTypeOf("function");
  expect(Reflect.get(contracts, "authoritativeNativeReviewSchema")).toBeUndefined();
  expect(exports).toHaveProperty("./dim-legacy-codec");
});

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
  const envelope = createReviewEnvelope({
    identity: {
      schemaVersion: 1,
      namespaceId: "tenant",
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
  const legacy = encodeDimLegacyReviewEnvelope(envelope);

  // Then
  expect(candidate).toMatchObject({
    namespaceId: "tenant",
    repositoryId: "application",
    reviewId: envelope.review.reviewId,
    envelopeId: envelope.envelopeId,
    candidateCommit: snapshot.commit,
    candidateTree: snapshot.tree,
  });
  expect({ reviewId: envelope.review.reviewId, envelopeId: envelope.envelopeId }).toEqual({
    reviewId: "44c7e64923883d2a1aacf74cd0b5daa4aae73989cbaf3bf70fe6feb8f2f7ba27",
    envelopeId: "359e90ef1ea4f37f197c8d4de8c9c611954ff7e7de8cdec0445c70008076e1fa",
  });
  expect(legacy.review).toMatchObject({ serviceId: "native-main", projectId: "tenant" });
  expect(decodeDimLegacyReviewEnvelope(legacy)).toEqual(envelope);
});
