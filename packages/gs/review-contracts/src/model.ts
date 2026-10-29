import { isCandidateRef, repositorySnapshotsSchema } from "@slop-lab/gs-repository-contracts";
import { z } from "zod";

export const reviewIdentifierSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const reviewPrincipalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const reviewObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const reviewDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const mode = z.string().regex(/^[0-7]{6}$/);
export const reviewBase64Schema = z.string().refine((value) => Buffer.from(value, "base64").toString("base64") === value);
const candidatePrincipal = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((value) =>
  Buffer.from(value, "base64url").length === 32
  && Buffer.from(value, "base64url").toString("base64url") === value);

export const reviewRequestSchema = z.object({
  namespaceId: reviewIdentifierSchema,
  repositoryId: reviewIdentifierSchema,
  proposalRef: z.string().refine(isCandidateRef),
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  requesterPrincipalId: reviewPrincipalIdSchema.optional(),
}).strict().readonly();

export const reviewChangedPathSchema = z.object({
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  oldPath: z.string().optional(),
  newPath: z.string().optional(),
  oldPathBytes: reviewBase64Schema,
  newPathBytes: reviewBase64Schema,
  oldMode: mode,
  newMode: mode,
  oldObjectId: reviewObjectIdSchema.or(z.literal("0")),
  newObjectId: reviewObjectIdSchema.or(z.literal("0")),
  similarity: z.number().int().min(0).max(100).optional(),
  oldSymlinkTarget: z.string().optional(),
  newSymlinkTarget: z.string().optional(),
  oldSymlinkTargetBytes: reviewBase64Schema.optional(),
  newSymlinkTargetBytes: reviewBase64Schema.optional(),
}).strict().readonly();

const reviewIdentityObjectSchema = z.object({
  schemaVersion: z.literal(1),
  namespaceId: reviewIdentifierSchema,
  repositoryId: reviewIdentifierSchema,
  inputs: repositorySnapshotsSchema,
  protectedRef: z.string(),
  proposalRef: z.string(),
  expectedProtectedHead: reviewObjectIdSchema,
  candidateCommit: reviewObjectIdSchema,
  candidateTree: reviewObjectIdSchema,
  policyRevision: reviewDigestSchema,
  requiredReviewRevision: reviewDigestSchema,
  candidatePrincipalId: candidatePrincipal.optional(),
  requiredReviewerIds: z.array(reviewIdentifierSchema).readonly(),
  changeRuleEvidence: z.array(z.object({
    rule: z.number().int().nonnegative(),
    digest: reviewDigestSchema,
  }).strict().readonly()).readonly().optional(),
  changes: z.array(reviewChangedPathSchema).readonly(),
  patch: z.string(),
  patchBytes: reviewBase64Schema,
}).strict();

export const reviewIdentitySchema = reviewIdentityObjectSchema.readonly();

export const reviewSchema = reviewIdentityObjectSchema.extend({
  reviewId: reviewDigestSchema,
  createdAt: z.string().datetime(),
}).strict().readonly();

export const reviewAttachmentSchema = z.object({
  kind: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
  digest: reviewDigestSchema,
}).strict().readonly();

export const reviewEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: reviewDigestSchema,
  review: reviewSchema,
  policyDigest: reviewDigestSchema,
  attachments: z.array(reviewAttachmentSchema).max(64).readonly(),
}).strict().readonly();

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type ReviewChangedPath = z.infer<typeof reviewChangedPathSchema>;
export type ReviewIdentity = z.infer<typeof reviewIdentitySchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ReviewAttachment = z.infer<typeof reviewAttachmentSchema>;
export type ReviewEnvelope = z.infer<typeof reviewEnvelopeSchema>;
