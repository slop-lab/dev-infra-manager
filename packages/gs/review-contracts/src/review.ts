import { isDeepStrictEqual } from "node:util";
import { candidatePrincipalId, isCandidateRef } from "@slop-lab/gs-repository-contracts";
import {
  dimLegacyEnvelopeDigest,
  dimLegacyReviewDigest,
  encodeDimLegacyReviewEnvelope,
} from "./dim-legacy-codec.js";
import {
  reviewDigestSchema,
  reviewEnvelopeSchema,
  reviewIdentifierSchema,
  reviewObjectIdSchema,
  reviewSchema,
  type ReviewAttachment,
  type ReviewEnvelope,
  type ReviewIdentity,
} from "./model.js";

export * from "./model.js";

import { z } from "zod";

export const reviewedCandidateSchema = z.object({
  reviewId: reviewDigestSchema,
  envelopeId: reviewDigestSchema,
  namespaceId: reviewIdentifierSchema,
  repositoryId: reviewIdentifierSchema,
  proposalRef: z.string(),
  protectedRef: z.string(),
  expectedProtectedHead: reviewObjectIdSchema,
  candidateCommit: reviewObjectIdSchema,
  candidateTree: reviewObjectIdSchema,
  policyDigest: reviewDigestSchema,
}).strict().readonly();

export type ReviewedCandidate = ReturnType<typeof reviewedCandidateSchema.parse>;

export function reviewDigest(identity: ReviewIdentity): string {
  return dimLegacyReviewDigest(identity);
}

export function createReviewEnvelope(input: {
  readonly identity: ReviewIdentity;
  readonly policyDigest: string;
  readonly attachments: readonly ReviewAttachment[];
  readonly createdAt: string;
}): ReviewEnvelope {
  assertSortedUnique(input.identity.requiredReviewerIds);
  const review = reviewSchema.parse({
    ...input.identity,
    reviewId: reviewDigest(input.identity),
    createdAt: input.createdAt,
  });
  const attachments = [...input.attachments]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const envelope = reviewEnvelopeSchema.parse({
    schemaVersion: 1,
    envelopeId: dimLegacyEnvelopeDigest(review.reviewId, input.policyDigest, attachments),
    review,
    policyDigest: input.policyDigest,
    attachments,
  });
  return parseReviewEnvelope(envelope);
}

export function parseReviewEnvelope(input: unknown): ReviewEnvelope {
  const envelope = reviewEnvelopeSchema.parse(input);
  const { reviewId, createdAt: _createdAt, ...identity } = envelope.review;
  assertSortedUnique(identity.requiredReviewerIds);
  const primary = { commit: identity.candidateCommit, tree: identity.candidateTree };
  if (!Object.hasOwn(identity.inputs, identity.repositoryId)
    || !isDeepStrictEqual(identity.inputs[identity.repositoryId], primary)) invalid("primary repository snapshot");
  if (!isCandidateRef(identity.proposalRef)
    || candidatePrincipalId(identity.proposalRef) !== identity.candidatePrincipalId
    || reviewDigest(identity) !== reviewId) invalid("review identity");
  assertSortedUnique(envelope.attachments.map((attachment) => `${attachment.kind}\0${attachment.id}`));
  if (envelope.envelopeId !== dimLegacyEnvelopeDigest(reviewId, envelope.policyDigest, envelope.attachments)) {
    invalid("envelope identity");
  }
  encodeDimLegacyReviewEnvelope(envelope);
  return envelope;
}

export function reviewedCandidate(envelope: ReviewEnvelope): ReviewedCandidate {
  return reviewedCandidateSchema.parse({
    reviewId: envelope.review.reviewId,
    envelopeId: envelope.envelopeId,
    namespaceId: envelope.review.namespaceId,
    repositoryId: envelope.review.repositoryId,
    proposalRef: envelope.review.proposalRef,
    protectedRef: envelope.review.protectedRef,
    expectedProtectedHead: envelope.review.expectedProtectedHead,
    candidateCommit: envelope.review.candidateCommit,
    candidateTree: envelope.review.candidateTree,
    policyDigest: envelope.policyDigest,
  });
}

function assertSortedUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length || values.some((value, index) => {
    const previous = values[index - 1];
    return previous !== undefined && value <= previous;
  })) invalid("set ordering");
}

function invalid(part: string): never {
  throw new ReviewSchemaError(`review ${part} is invalid`);
}

export class ReviewSchemaError extends Error {
  readonly name = "ReviewSchemaError";
}
