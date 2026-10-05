import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import type { NativeHostClaim, NativeHostClaimRequest } from "./nativeOrdinaryClaimProtocol.js";
import { parseStoredDescriptor, parseStoredIssuance } from "./nativeOrdinaryClaimProtocol.js";
import { requiredClaimNumber, requiredClaimString } from "./nativeOrdinaryAuthorityRows.js";

type ActiveClaimInput = {
  readonly database: DatabaseSync;
  readonly serviceId: string;
  readonly request: NativeHostClaimRequest;
  readonly claimId: string;
};

export function loadActiveNativeHostClaim(input: ActiveClaimInput): NativeHostClaim {
  const row = input.database.prepare(`
    SELECT event_id, review_id, attempt_id, admission_generation, host_id, capacity,
      lease_expires_at, descriptor_json, descriptor_digest, issuance_json
    FROM claims WHERE claim_id = ? AND state = 'active'
  `).get(input.claimId);
  const reviewId = requiredClaimString(row, "review_id");
  const attemptId = requiredClaimString(row, "attempt_id");
  const hostId = requiredClaimString(row, "host_id");
  const capacity = requiredClaimString(row, "capacity");
  const descriptorDigest = requiredClaimString(row, "descriptor_digest");
  const issuance = parseStoredIssuance(requiredClaimString(row, "issuance_json"));
  if (issuance.reviewId !== reviewId || issuance.attemptId !== attemptId || issuance.hostId !== hostId
    || issuance.capacity !== capacity || issuance.descriptorDigest !== descriptorDigest) {
    throw new UserError("native ordinary database claim does not match issuance");
  }
  return {
    schemaVersion: 1,
    serviceId: input.serviceId,
    requestId: input.request.requestId,
    claimId: input.claimId,
    eventId: requiredClaimString(row, "event_id"),
    reviewId,
    attemptId,
    attempt: issuance.attempt,
    admissionGeneration: requiredClaimString(row, "admission_generation"),
    hostId,
    capacity,
    leaseExpiresAt: requiredClaimNumber(row, "lease_expires_at"),
    descriptor: parseStoredDescriptor(requiredClaimString(row, "descriptor_json")),
    descriptorDigest
  };
}
