import { createHash } from "node:crypto";
import { z } from "zod";
import { reviewDigestSchema, reviewIdentifierSchema } from "./model.js";

const approvalIdentitySchema = z.object({
  reviewId: reviewDigestSchema,
  reviewerId: reviewIdentifierSchema,
  requestId: z.string().uuid(),
}).strict();

const approvalRecordIdentitySchema = approvalIdentitySchema.extend({
  schemaVersion: z.literal(1),
  approvalId: reviewDigestSchema,
  approvedAt: z.string().datetime(),
}).strict();

export const reviewApprovalSchema = approvalRecordIdentitySchema.extend({
  recordDigest: reviewDigestSchema,
}).strict().readonly();

const revocationIdentitySchema = z.object({
  reviewId: reviewDigestSchema,
  reviewerId: reviewIdentifierSchema,
  approvalId: reviewDigestSchema,
}).strict();

const revocationRecordIdentitySchema = revocationIdentitySchema.extend({
  schemaVersion: z.literal(1),
  revocationId: reviewDigestSchema,
  revokedAt: z.string().datetime(),
}).strict();

export const reviewRevocationSchema = revocationRecordIdentitySchema.extend({
  recordDigest: reviewDigestSchema,
}).strict().readonly();

export type ReviewApprovalIdentity = z.infer<typeof approvalIdentitySchema>;
export type ReviewApproval = z.infer<typeof reviewApprovalSchema>;
export type ReviewRevocationIdentity = z.infer<typeof revocationIdentitySchema>;
export type ReviewRevocation = z.infer<typeof reviewRevocationSchema>;

export function reviewApprovalId(identity: ReviewApprovalIdentity): string {
  return domainDigest("dim-native-authoritative-approval-id-v1\0", identity);
}

export function createReviewApproval(identityInput: ReviewApprovalIdentity, approvedAt: string): ReviewApproval {
  const identity = approvalIdentitySchema.parse(identityInput);
  const recordIdentity = approvalRecordIdentitySchema.parse({
    schemaVersion: 1,
    ...identity,
    approvalId: reviewApprovalId(identity),
    approvedAt,
  });
  return reviewApprovalSchema.parse({
    ...recordIdentity,
    recordDigest: domainDigest("dim-native-authoritative-approval-record-v1\0", recordIdentity),
  });
}

export function parseReviewApproval(input: unknown): ReviewApproval {
  const approval = reviewApprovalSchema.parse(input);
  const { recordDigest, ...recordIdentity } = approval;
  const { schemaVersion: _schemaVersion, approvalId, approvedAt: _approvedAt, ...identity } = recordIdentity;
  if (reviewApprovalId(identity) !== approvalId
    || domainDigest("dim-native-authoritative-approval-record-v1\0", recordIdentity) !== recordDigest) {
    throw new ReviewApprovalSchemaError("review approval digest is invalid");
  }
  return approval;
}

export function reviewRevocationId(identity: ReviewRevocationIdentity): string {
  return domainDigest("dim-native-authoritative-revocation-id-v1\0", identity);
}

export function createReviewRevocation(identityInput: ReviewRevocationIdentity, revokedAt: string): ReviewRevocation {
  const identity = revocationIdentitySchema.parse(identityInput);
  const recordIdentity = revocationRecordIdentitySchema.parse({
    schemaVersion: 1,
    ...identity,
    revocationId: reviewRevocationId(identity),
    revokedAt,
  });
  return reviewRevocationSchema.parse({
    ...recordIdentity,
    recordDigest: domainDigest("dim-native-authoritative-revocation-record-v1\0", recordIdentity),
  });
}

export function parseReviewRevocation(input: unknown): ReviewRevocation {
  const revocation = reviewRevocationSchema.parse(input);
  const { recordDigest, ...recordIdentity } = revocation;
  const { schemaVersion: _schemaVersion, revocationId, revokedAt: _revokedAt, ...identity } = recordIdentity;
  if (reviewRevocationId(identity) !== revocationId
    || domainDigest("dim-native-authoritative-revocation-record-v1\0", recordIdentity) !== recordDigest) {
    throw new ReviewRevocationSchemaError("review revocation digest is invalid");
  }
  return revocation;
}

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(value)).digest("hex");
}

export class ReviewApprovalSchemaError extends Error {
  readonly name = "ReviewApprovalSchemaError";
}
export class ReviewRevocationSchemaError extends Error {
  readonly name = "ReviewRevocationSchemaError";
}
