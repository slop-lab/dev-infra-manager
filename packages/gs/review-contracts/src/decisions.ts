import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

const approvalIdentitySchema = z.object({
  reviewId: digest,
  reviewerId: identifier,
  requestId: z.string().uuid(),
}).strict();

const approvalRecordIdentitySchema = approvalIdentitySchema.extend({
  schemaVersion: z.literal(1),
  approvalId: digest,
  approvedAt: z.string().datetime(),
}).strict();

export const authoritativeNativeApprovalSchema = approvalRecordIdentitySchema.extend({
  recordDigest: digest,
}).strict().readonly();

const revocationIdentitySchema = z.object({
  reviewId: digest,
  reviewerId: identifier,
  approvalId: digest,
}).strict();

const revocationRecordIdentitySchema = revocationIdentitySchema.extend({
  schemaVersion: z.literal(1),
  revocationId: digest,
  revokedAt: z.string().datetime(),
}).strict();

export const authoritativeNativeRevocationSchema = revocationRecordIdentitySchema.extend({
  recordDigest: digest,
}).strict().readonly();

export type AuthoritativeNativeApprovalIdentity = z.infer<typeof approvalIdentitySchema>;
export type AuthoritativeNativeApproval = z.infer<typeof authoritativeNativeApprovalSchema>;
export type AuthoritativeNativeRevocationIdentity = z.infer<typeof revocationIdentitySchema>;
export type AuthoritativeNativeRevocation = z.infer<typeof authoritativeNativeRevocationSchema>;

export function authoritativeNativeApprovalId(identity: AuthoritativeNativeApprovalIdentity): string {
  return domainDigest("dim-native-authoritative-approval-id-v1\0", identity);
}

export function createAuthoritativeNativeApproval(
  identityInput: AuthoritativeNativeApprovalIdentity,
  approvedAt: string,
): AuthoritativeNativeApproval {
  const identity = approvalIdentitySchema.parse(identityInput);
  const recordIdentity = approvalRecordIdentitySchema.parse({
    schemaVersion: 1,
    ...identity,
    approvalId: authoritativeNativeApprovalId(identity),
    approvedAt,
  });
  return authoritativeNativeApprovalSchema.parse({
    ...recordIdentity,
    recordDigest: domainDigest("dim-native-authoritative-approval-record-v1\0", recordIdentity),
  });
}

export function parseAuthoritativeNativeApproval(input: unknown): AuthoritativeNativeApproval {
  const approval = authoritativeNativeApprovalSchema.parse(input);
  const { recordDigest, ...recordIdentity } = approval;
  const { schemaVersion: _schemaVersion, approvalId, approvedAt: _approvedAt, ...identity } = recordIdentity;
  if (authoritativeNativeApprovalId(identity) !== approvalId
    || domainDigest("dim-native-authoritative-approval-record-v1\0", recordIdentity) !== recordDigest) {
    throw new AuthoritativeNativeApprovalSchemaError("authoritative native approval digest is invalid");
  }
  return approval;
}

export function authoritativeNativeRevocationId(identity: AuthoritativeNativeRevocationIdentity): string {
  return domainDigest("dim-native-authoritative-revocation-id-v1\0", identity);
}

export function createAuthoritativeNativeRevocation(
  identityInput: AuthoritativeNativeRevocationIdentity,
  revokedAt: string,
): AuthoritativeNativeRevocation {
  const identity = revocationIdentitySchema.parse(identityInput);
  const recordIdentity = revocationRecordIdentitySchema.parse({
    schemaVersion: 1,
    ...identity,
    revocationId: authoritativeNativeRevocationId(identity),
    revokedAt,
  });
  return authoritativeNativeRevocationSchema.parse({
    ...recordIdentity,
    recordDigest: domainDigest("dim-native-authoritative-revocation-record-v1\0", recordIdentity),
  });
}

export function parseAuthoritativeNativeRevocation(input: unknown): AuthoritativeNativeRevocation {
  const revocation = authoritativeNativeRevocationSchema.parse(input);
  const { recordDigest, ...recordIdentity } = revocation;
  const { schemaVersion: _schemaVersion, revocationId, revokedAt: _revokedAt, ...identity } = recordIdentity;
  if (authoritativeNativeRevocationId(identity) !== revocationId
    || domainDigest("dim-native-authoritative-revocation-record-v1\0", recordIdentity) !== recordDigest) {
    throw new AuthoritativeNativeRevocationSchemaError("authoritative native revocation digest is invalid");
  }
  return revocation;
}

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(value)).digest("hex");
}

export class AuthoritativeNativeApprovalSchemaError extends Error {
  readonly name = "AuthoritativeNativeApprovalSchemaError";
}

export class AuthoritativeNativeRevocationSchemaError extends Error {
  readonly name = "AuthoritativeNativeRevocationSchemaError";
}
