import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { candidatePrincipalId, isCandidateRef, repositorySnapshotsSchema } from "@slop-lab/gs-repository-contracts";
import { z } from "zod";
import {
  reviewAttachmentSchema,
  reviewBase64Schema,
  reviewChangedPathSchema,
  reviewEnvelopeSchema,
  reviewIdentifierSchema,
  reviewObjectIdSchema,
  type Review,
  type ReviewAttachment,
  type ReviewEnvelope,
  type ReviewIdentity,
} from "./model.js";
import {
  createReviewApproval,
  createReviewRevocation,
  parseReviewApproval,
  parseReviewRevocation,
  reviewApprovalId,
  reviewApprovalSchema,
  reviewRevocationId,
  reviewRevocationSchema,
  type ReviewApproval,
  type ReviewApprovalIdentity,
  type ReviewRevocation,
  type ReviewRevocationIdentity,
} from "./decisions.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const stableWorkspaceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((value) =>
  Buffer.from(value, "base64url").length === 32
  && Buffer.from(value, "base64url").toString("base64url") === value);

const dimLegacyReviewIdentitySchema = z.object({
  schemaVersion: z.literal(2),
  serviceId: z.literal("native-main"),
  projectId: reviewIdentifierSchema,
  repositoryId: reviewIdentifierSchema,
  inputs: repositorySnapshotsSchema,
  protectedRef: z.string(),
  proposalRef: z.string(),
  expectedProtectedHead: reviewObjectIdSchema,
  candidateCommit: reviewObjectIdSchema,
  candidateTree: reviewObjectIdSchema,
  policyRevision: digest,
  requiredReviewRevision: digest,
  workspaceId: stableWorkspaceId.optional(),
  requiredReviewerIds: z.array(reviewIdentifierSchema).readonly(),
  changeRuleEvidence: z.array(z.object({
    rule: z.number().int().nonnegative(),
    digest,
  }).strict().readonly()).readonly().optional(),
  changes: z.array(reviewChangedPathSchema).readonly(),
  patch: z.string(),
  patchBytes: reviewBase64Schema,
}).strict();

export const authoritativeNativeReviewSchema = dimLegacyReviewIdentitySchema.extend({
  reviewId: digest,
  createdAt: z.string().datetime(),
}).strict().readonly();

export const authoritativeNativeReviewEnvelopeSchema = z.object({
  schemaVersion: z.literal(3),
  envelopeId: digest,
  review: authoritativeNativeReviewSchema,
  policyDigest: digest,
  attachments: z.array(reviewAttachmentSchema).max(64).readonly(),
}).strict().readonly();

export const authoritativeNativeChangedPathSchema = reviewChangedPathSchema;
export const authoritativeNativeApprovalSchema = reviewApprovalSchema;
export const authoritativeNativeRevocationSchema = reviewRevocationSchema;

export type AuthoritativeNativeChangedPath = z.infer<typeof authoritativeNativeChangedPathSchema>;
export type AuthoritativeNativeReviewIdentity = z.infer<typeof dimLegacyReviewIdentitySchema>;
export type AuthoritativeNativeReviewIdentityWithoutInputs = Omit<AuthoritativeNativeReviewIdentity, "inputs">;
export type AuthoritativeNativeReview = z.infer<typeof authoritativeNativeReviewSchema>;
export type AuthoritativeNativeReviewEnvelope = z.infer<typeof authoritativeNativeReviewEnvelopeSchema>;
export type AuthoritativeNativeApprovalIdentity = ReviewApprovalIdentity;
export type AuthoritativeNativeApproval = ReviewApproval;
export type AuthoritativeNativeRevocationIdentity = ReviewRevocationIdentity;
export type AuthoritativeNativeRevocation = ReviewRevocation;

export function encodeDimLegacyReviewIdentity(identity: ReviewIdentity): AuthoritativeNativeReviewIdentity {
  return dimLegacyReviewIdentitySchema.parse({
    schemaVersion: 2,
    serviceId: "native-main",
    projectId: identity.namespaceId,
    repositoryId: identity.repositoryId,
    inputs: identity.inputs,
    protectedRef: identity.protectedRef,
    proposalRef: identity.proposalRef,
    expectedProtectedHead: identity.expectedProtectedHead,
    candidateCommit: identity.candidateCommit,
    candidateTree: identity.candidateTree,
    policyRevision: identity.policyRevision,
    requiredReviewRevision: identity.requiredReviewRevision,
    ...(identity.candidatePrincipalId === undefined ? {} : { workspaceId: identity.candidatePrincipalId }),
    requiredReviewerIds: identity.requiredReviewerIds,
    ...(identity.changeRuleEvidence === undefined ? {} : { changeRuleEvidence: identity.changeRuleEvidence }),
    changes: identity.changes,
    patch: identity.patch,
    patchBytes: identity.patchBytes,
  });
}

export function encodeDimLegacyReviewIdentityWithoutInputs(
  identity: Omit<ReviewIdentity, "inputs">,
): AuthoritativeNativeReviewIdentityWithoutInputs {
  return {
    schemaVersion: 2,
    serviceId: "native-main",
    projectId: identity.namespaceId,
    repositoryId: identity.repositoryId,
    protectedRef: identity.protectedRef,
    proposalRef: identity.proposalRef,
    expectedProtectedHead: identity.expectedProtectedHead,
    candidateCommit: identity.candidateCommit,
    candidateTree: identity.candidateTree,
    policyRevision: identity.policyRevision,
    requiredReviewRevision: identity.requiredReviewRevision,
    ...(identity.candidatePrincipalId === undefined ? {} : { workspaceId: identity.candidatePrincipalId }),
    requiredReviewerIds: identity.requiredReviewerIds,
    ...(identity.changeRuleEvidence === undefined ? {} : { changeRuleEvidence: identity.changeRuleEvidence }),
    changes: identity.changes,
    patch: identity.patch,
    patchBytes: identity.patchBytes,
  };
}

export function encodeDimLegacyReviewEnvelope(envelope: ReviewEnvelope): AuthoritativeNativeReviewEnvelope {
  return authoritativeNativeReviewEnvelopeSchema.parse({
    schemaVersion: 3,
    envelopeId: envelope.envelopeId,
    review: {
      ...encodeDimLegacyReviewIdentity(envelope.review),
      reviewId: envelope.review.reviewId,
      createdAt: envelope.review.createdAt,
    },
    policyDigest: envelope.policyDigest,
    attachments: envelope.attachments,
  });
}

export function decodeDimLegacyReviewIdentity(input: AuthoritativeNativeReviewIdentity): ReviewIdentity {
  const identity = dimLegacyReviewIdentitySchema.parse(input);
  return {
    schemaVersion: 1,
    namespaceId: identity.projectId,
    repositoryId: identity.repositoryId,
    inputs: identity.inputs,
    protectedRef: identity.protectedRef,
    proposalRef: identity.proposalRef,
    expectedProtectedHead: identity.expectedProtectedHead,
    candidateCommit: identity.candidateCommit,
    candidateTree: identity.candidateTree,
    policyRevision: identity.policyRevision,
    requiredReviewRevision: identity.requiredReviewRevision,
    ...(identity.workspaceId === undefined ? {} : { candidatePrincipalId: identity.workspaceId }),
    requiredReviewerIds: identity.requiredReviewerIds,
    ...(identity.changeRuleEvidence === undefined ? {} : { changeRuleEvidence: identity.changeRuleEvidence }),
    changes: identity.changes,
    patch: identity.patch,
    patchBytes: identity.patchBytes,
  };
}

export function decodeDimLegacyReviewEnvelope(input: unknown): ReviewEnvelope {
  const envelope = parseAuthoritativeNativeReviewEnvelope(input);
  const { reviewId, createdAt, ...identity } = envelope.review;
  return reviewEnvelopeSchema.parse({
    schemaVersion: 1,
    envelopeId: envelope.envelopeId,
    review: {
      ...decodeDimLegacyReviewIdentity(identity),
      reviewId,
      createdAt,
    },
    policyDigest: envelope.policyDigest,
    attachments: envelope.attachments,
  });
}

export function dimLegacyReviewDigest(identity: ReviewIdentity): string {
  return domainDigest("dim-native-authoritative-review-v2\0", encodeDimLegacyReviewIdentity(identity));
}

export function dimLegacyEnvelopeDigest(
  reviewId: string,
  policyDigest: string,
  attachments: readonly ReviewAttachment[],
): string {
  return domainDigest("dim-code-review-envelope-v3\0", { reviewId, policyDigest, attachments });
}

export function authoritativeNativeReviewDigest(identity: AuthoritativeNativeReviewIdentity): string {
  return domainDigest("dim-native-authoritative-review-v2\0", identity);
}

export function createAuthoritativeNativeReviewEnvelope(input: {
  readonly identity: AuthoritativeNativeReviewIdentity;
  readonly policyDigest: string;
  readonly attachments: readonly ReviewAttachment[];
  readonly createdAt: string;
}): AuthoritativeNativeReviewEnvelope {
  const review = authoritativeNativeReviewSchema.parse({
    ...input.identity,
    reviewId: authoritativeNativeReviewDigest(input.identity),
    createdAt: input.createdAt,
  });
  const attachments = [...input.attachments]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return parseAuthoritativeNativeReviewEnvelope({
    schemaVersion: 3,
    envelopeId: dimLegacyEnvelopeDigest(review.reviewId, input.policyDigest, attachments),
    review,
    policyDigest: input.policyDigest,
    attachments,
  });
}

export function parseAuthoritativeNativeReviewEnvelope(input: unknown): AuthoritativeNativeReviewEnvelope {
  const envelope = authoritativeNativeReviewEnvelopeSchema.parse(input);
  const { reviewId, createdAt: _createdAt, ...identity } = envelope.review;
  const primary = { commit: identity.candidateCommit, tree: identity.candidateTree };
  if (!Object.hasOwn(identity.inputs, identity.repositoryId)
    || !isDeepStrictEqual(identity.inputs[identity.repositoryId], primary)
    || !isCandidateRef(identity.proposalRef)
    || candidatePrincipalId(identity.proposalRef) !== identity.workspaceId
    || authoritativeNativeReviewDigest(identity) !== reviewId
    || envelope.envelopeId !== dimLegacyEnvelopeDigest(reviewId, envelope.policyDigest, envelope.attachments)) {
    throw new AuthoritativeNativeReviewSchemaError("authoritative native review identity is invalid");
  }
  return envelope;
}

export const authoritativeNativeApprovalId = reviewApprovalId;
export const createAuthoritativeNativeApproval = createReviewApproval;
export const parseAuthoritativeNativeApproval = parseReviewApproval;
export const authoritativeNativeRevocationId = reviewRevocationId;
export const createAuthoritativeNativeRevocation = createReviewRevocation;
export const parseAuthoritativeNativeRevocation = parseReviewRevocation;

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}

export class AuthoritativeNativeReviewSchemaError extends Error {
  readonly name = "AuthoritativeNativeReviewSchemaError";
}
export class AuthoritativeNativeApprovalSchemaError extends Error {
  readonly name = "AuthoritativeNativeApprovalSchemaError";
}
export class AuthoritativeNativeRevocationSchemaError extends Error {
  readonly name = "AuthoritativeNativeRevocationSchemaError";
}
