import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

const approvalIdentitySchema = z.object({
  reviewId: digest,
  reviewerId: identifier,
  requestId: z.string().uuid()
}).strict();

const approvalRecordIdentitySchema = approvalIdentitySchema.extend({
  schemaVersion: z.literal(1),
  approvalId: digest,
  approvedAt: z.string().datetime()
}).strict();

export const authoritativeNativeApprovalSchema = approvalRecordIdentitySchema.extend({
  recordDigest: digest
}).strict().readonly();

export type AuthoritativeNativeApprovalIdentity = z.infer<typeof approvalIdentitySchema>;
export type AuthoritativeNativeApproval = z.infer<typeof authoritativeNativeApprovalSchema>;

export function authoritativeNativeApprovalId(identity: AuthoritativeNativeApprovalIdentity): string {
  return domainDigest("dim-native-authoritative-approval-id-v1\0", identity);
}

export function createAuthoritativeNativeApproval(
  identityInput: AuthoritativeNativeApprovalIdentity,
  approvedAt: string
): AuthoritativeNativeApproval {
  const identity = approvalIdentitySchema.parse(identityInput);
  const recordIdentity = approvalRecordIdentitySchema.parse({
    schemaVersion: 1,
    ...identity,
    approvalId: authoritativeNativeApprovalId(identity),
    approvedAt
  });
  return authoritativeNativeApprovalSchema.parse({
    ...recordIdentity,
    recordDigest: domainDigest("dim-native-authoritative-approval-record-v1\0", recordIdentity)
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

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(value)).digest("hex");
}

export class AuthoritativeNativeApprovalSchemaError extends Error {
  readonly name = "AuthoritativeNativeApprovalSchemaError";
}
