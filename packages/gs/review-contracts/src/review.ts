import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  candidatePrincipalId,
  isCandidateRef,
  repositorySnapshotsSchema,
} from "@slop-lab/gs-repository-contracts";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const principalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const mode = z.string().regex(/^[0-7]{6}$/);
const base64 = z.string().refine((value) => Buffer.from(value, "base64").toString("base64") === value);
const stableWorkspaceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((value) =>
  Buffer.from(value, "base64url").length === 32
  && Buffer.from(value, "base64url").toString("base64url") === value);

export const reviewRequestSchema = z.object({
  namespaceId: identifier,
  repositoryId: identifier,
  proposalRef: z.string().refine(isCandidateRef),
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  requesterPrincipalId: principalId.optional(),
}).strict().readonly();

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const authoritativeNativeChangedPathSchema = z.object({
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  oldPath: z.string().optional(),
  newPath: z.string().optional(),
  oldPathBytes: base64,
  newPathBytes: base64,
  oldMode: mode,
  newMode: mode,
  oldObjectId: objectId.or(z.literal("0")),
  newObjectId: objectId.or(z.literal("0")),
  similarity: z.number().int().min(0).max(100).optional(),
  oldSymlinkTarget: z.string().optional(),
  newSymlinkTarget: z.string().optional(),
  oldSymlinkTargetBytes: base64.optional(),
  newSymlinkTargetBytes: base64.optional(),
}).strict().readonly();

const identityObjectSchema = z.object({
  schemaVersion: z.literal(2),
  serviceId: z.literal("native-main"),
  projectId: identifier,
  repositoryId: identifier,
  inputs: repositorySnapshotsSchema,
  protectedRef: z.string(),
  proposalRef: z.string(),
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: digest,
  requiredReviewRevision: digest,
  workspaceId: stableWorkspaceId.optional(),
  requiredReviewerIds: z.array(identifier).readonly(),
  changeRuleEvidence: z.array(z.object({
    rule: z.number().int().nonnegative(),
    digest,
  }).strict().readonly()).readonly().optional(),
  changes: z.array(authoritativeNativeChangedPathSchema).readonly(),
  patch: z.string(),
  patchBytes: base64,
}).strict();

export const authoritativeNativeReviewSchema = identityObjectSchema.extend({
  reviewId: digest,
  createdAt: z.string().datetime(),
}).strict().readonly();

export const reviewAttachmentSchema = z.object({
  kind: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
  digest,
}).strict().readonly();

export const authoritativeNativeReviewEnvelopeSchema = z.object({
  schemaVersion: z.literal(3),
  envelopeId: digest,
  review: authoritativeNativeReviewSchema,
  policyDigest: digest,
  attachments: z.array(reviewAttachmentSchema).max(64).readonly(),
}).strict().readonly();

export const reviewedCandidateSchema = z.object({
  reviewId: digest,
  envelopeId: digest,
  namespaceId: identifier,
  repositoryId: identifier,
  proposalRef: z.string(),
  protectedRef: z.string(),
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyDigest: digest,
}).strict().readonly();

export type AuthoritativeNativeChangedPath = z.infer<typeof authoritativeNativeChangedPathSchema>;
export type AuthoritativeNativeReviewIdentity = z.infer<typeof identityObjectSchema>;
export type AuthoritativeNativeReview = z.infer<typeof authoritativeNativeReviewSchema>;
export type AuthoritativeNativeReviewEnvelope = z.infer<typeof authoritativeNativeReviewEnvelopeSchema>;
export type ReviewAttachment = z.infer<typeof reviewAttachmentSchema>;
export type ReviewedCandidate = z.infer<typeof reviewedCandidateSchema>;

export function authoritativeNativeReviewDigest(identity: AuthoritativeNativeReviewIdentity): string {
  return domainDigest("dim-native-authoritative-review-v2\0", identity);
}

export function createAuthoritativeNativeReviewEnvelope(input: {
  readonly identity: AuthoritativeNativeReviewIdentity;
  readonly policyDigest: string;
  readonly attachments: readonly ReviewAttachment[];
  readonly createdAt: string;
}): AuthoritativeNativeReviewEnvelope {
  assertSortedUnique(input.identity.requiredReviewerIds);
  const review = authoritativeNativeReviewSchema.parse({
    ...input.identity,
    reviewId: authoritativeNativeReviewDigest(input.identity),
    createdAt: input.createdAt,
  });
  const attachments = [...input.attachments]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return parseAuthoritativeNativeReviewEnvelope({
    schemaVersion: 3,
    envelopeId: domainDigest("dim-code-review-envelope-v3\0", {
      reviewId: review.reviewId,
      policyDigest: input.policyDigest,
      attachments,
    }),
    review,
    policyDigest: input.policyDigest,
    attachments,
  });
}

export function parseAuthoritativeNativeReviewEnvelope(input: unknown): AuthoritativeNativeReviewEnvelope {
  const envelope = authoritativeNativeReviewEnvelopeSchema.parse(input);
  const { reviewId, createdAt: _createdAt, ...identity } = envelope.review;
  assertSortedUnique(identity.requiredReviewerIds);
  const primary = { commit: identity.candidateCommit, tree: identity.candidateTree };
  if (!Object.hasOwn(identity.inputs, identity.repositoryId)
    || !isDeepStrictEqual(identity.inputs[identity.repositoryId], primary)) invalid("primary repository snapshot");
  if (!isCandidateRef(identity.proposalRef)
    || candidatePrincipalId(identity.proposalRef) !== identity.workspaceId
    || authoritativeNativeReviewDigest(identity) !== reviewId) invalid("review identity");
  assertSortedUnique(envelope.attachments.map((attachment) => `${attachment.kind}\0${attachment.id}`));
  if (envelope.envelopeId !== domainDigest("dim-code-review-envelope-v3\0", {
    reviewId,
    policyDigest: envelope.policyDigest,
    attachments: envelope.attachments,
  })) invalid("envelope identity");
  return envelope;
}

export function reviewedCandidate(envelope: AuthoritativeNativeReviewEnvelope): ReviewedCandidate {
  return reviewedCandidateSchema.parse({
    reviewId: envelope.review.reviewId,
    envelopeId: envelope.envelopeId,
    namespaceId: envelope.review.projectId,
    repositoryId: envelope.review.repositoryId,
    proposalRef: envelope.review.proposalRef,
    protectedRef: envelope.review.protectedRef,
    expectedProtectedHead: envelope.review.expectedProtectedHead,
    candidateCommit: envelope.review.candidateCommit,
    candidateTree: envelope.review.candidateTree,
    policyDigest: envelope.policyDigest,
  });
}

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(Reflect.get(value, key));
  return canonical;
}

function assertSortedUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length || values.some((value, index) => {
    const previous = values[index - 1];
    return previous !== undefined && value <= previous;
  })) invalid("set ordering");
}

function invalid(part: string): never {
  throw new AuthoritativeNativeReviewSchemaError(`authoritative native ${part} is invalid`);
}

export class AuthoritativeNativeReviewSchemaError extends Error {
  readonly name = "AuthoritativeNativeReviewSchemaError";
}
