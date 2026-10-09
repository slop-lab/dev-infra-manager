import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

const revocationIdentitySchema = z.object({
  reviewId: digest,
  reviewerId: identifier,
  approvalId: digest
}).strict();

const revocationRecordIdentitySchema = revocationIdentitySchema.extend({
  schemaVersion: z.literal(1),
  revocationId: digest,
  revokedAt: z.string().datetime()
}).strict();

export const authoritativeNativeRevocationSchema = revocationRecordIdentitySchema.extend({
  recordDigest: digest
}).strict().readonly();

export type AuthoritativeNativeRevocationIdentity = z.infer<typeof revocationIdentitySchema>;
export type AuthoritativeNativeRevocation = z.infer<typeof authoritativeNativeRevocationSchema>;

export function authoritativeNativeRevocationId(identity: AuthoritativeNativeRevocationIdentity): string {
  return domainDigest("dim-native-authoritative-revocation-id-v1\0", identity);
}

export function createAuthoritativeNativeRevocation(
  identityInput: AuthoritativeNativeRevocationIdentity,
  revokedAt: string
): AuthoritativeNativeRevocation {
  const identity = revocationIdentitySchema.parse(identityInput);
  const recordIdentity = revocationRecordIdentitySchema.parse({
    schemaVersion: 1,
    ...identity,
    revocationId: authoritativeNativeRevocationId(identity),
    revokedAt
  });
  return authoritativeNativeRevocationSchema.parse({
    ...recordIdentity,
    recordDigest: domainDigest("dim-native-authoritative-revocation-record-v1\0", recordIdentity)
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

export class AuthoritativeNativeRevocationSchemaError extends Error {
  readonly name = "AuthoritativeNativeRevocationSchemaError";
}
