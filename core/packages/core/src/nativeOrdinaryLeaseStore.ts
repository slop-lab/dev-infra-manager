import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { NativeJobAttemptIssuance, NativeJobAttemptRevocation } from "./nativeGitAttemptIssuerModel.js";
import { parseNativeJobAttemptIssuance, parseNativeJobAttemptRevocation } from "./nativeGitAttemptIssuerModel.js";
import { requiredClaimNumber, requiredClaimString, stringField } from "./nativeOrdinaryAuthorityRows.js";
import type {
  NativeHostClaimRenewal,
  NativeHostClaimRenewalRequest,
  NativeHostRecoveryRequest
} from "./nativeOrdinaryClaimProtocol.js";
import { NativeOrdinaryStaleAuthorityError } from "./nativeOrdinaryClaimStore.js";

type LeaseStoreOptions = {
  readonly serviceId: string;
  readonly ownedEpochId: string;
  readonly claimLeaseMilliseconds: number;
  readonly now: () => number;
};

export type NativeRecoveryPreparation =
  | { readonly kind: "conflict" }
  | { readonly kind: "released" }
  | { readonly kind: "pending"; readonly issuance: NativeJobAttemptIssuance };

export class NativeOrdinaryLeaseStore {
  readonly #database: DatabaseSync;
  readonly #options: LeaseStoreOptions;

  constructor(database: DatabaseSync, options: LeaseStoreOptions) {
    this.#database = database;
    this.#options = options;
  }

  renew(request: NativeHostClaimRenewalRequest): NativeHostClaimRenewal | undefined {
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertOwnedEpoch();
      const row = this.#exactClaim(request);
      if (row === undefined || stringField(row, "state") !== "active"
        || stringField(row, "service_epoch_id") !== this.#options.ownedEpochId
        || requiredClaimNumber(row, "lease_expires_at") <= now) {
        return this.#finish(undefined);
      }
      const priorRequestId = stringField(row, "renewal_request_id");
      if (priorRequestId === request.requestId) {
        const leaseExpiresAt = requiredClaimNumber(row, "lease_expires_at");
        return this.#finish(this.#renewal(request, leaseExpiresAt, leaseExpiresAt - now));
      }
      const leaseExpiresAt = now + this.#options.claimLeaseMilliseconds;
      this.#database.prepare("UPDATE claims SET lease_expires_at = ?, renewal_request_id = ? WHERE claim_id = ?")
        .run(leaseExpiresAt, request.requestId, request.claimId);
      return this.#finish(this.#renewal(request, leaseExpiresAt, this.#options.claimLeaseMilliseconds));
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  prepareRecovery(request: NativeHostRecoveryRequest): NativeRecoveryPreparation {
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertOwnedEpoch();
      const row = this.#exactClaim(request);
      if (row === undefined || request.resourceId !== request.claimId) return this.#finish({ kind: "conflict" });
      const state = stringField(row, "state");
      const recoveryRequestId = stringField(row, "recovery_request_id");
      const recoveryResourceId = stringField(row, "recovery_resource_id");
      if (state === "released") {
        return this.#finish(recoveryRequestId === request.requestId && recoveryResourceId === request.resourceId
          && stringField(row, "native_revocation_json") !== undefined ? { kind: "released" } : { kind: "conflict" });
      }
      if (state !== "recovering" || (recoveryRequestId !== undefined && recoveryRequestId !== request.requestId)
        || (recoveryResourceId !== undefined && recoveryResourceId !== request.resourceId)
        || !this.#hasFence(request)) {
        return this.#finish({ kind: "conflict" });
      }
      if (recoveryRequestId === undefined) {
        this.#database.prepare(`
          UPDATE claims SET recovery_request_id = ?, recovery_resource_id = ?, cleanup_acknowledged_at = ?
          WHERE claim_id = ? AND state = 'recovering'
        `).run(request.requestId, request.resourceId, now, request.claimId);
      }
      return this.#finish({
        kind: "pending",
        issuance: parseStoredIssuance(requiredClaimString(row, "issuance_json"))
      });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  completeRecovery(request: NativeHostRecoveryRequest, proof: NativeJobAttemptRevocation): boolean {
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertOwnedEpoch();
      const row = this.#exactClaim(request);
      if (row === undefined || stringField(row, "state") !== "recovering"
        || stringField(row, "recovery_request_id") !== request.requestId
        || stringField(row, "recovery_resource_id") !== request.resourceId
        || !this.#hasFence(request)) return this.#finish(false);
      const issuance = parseStoredIssuance(requiredClaimString(row, "issuance_json"));
      const revocation = parseNativeJobAttemptRevocation(proof);
      if (!revocationMatches(issuance, revocation)) return this.#finish(false);
      const demandId = requiredClaimString(row, "demand_id");
      this.#database.prepare(`
        UPDATE claims SET state = 'released', native_revocation_json = ?, released_at = ? WHERE claim_id = ?
      `).run(JSON.stringify(revocation), now, request.claimId);
      this.#database.prepare(`
        UPDATE claim_receipts SET state = 'released', updated_at = ?, released_at = ? WHERE claim_id = ?
      `).run(now, now, request.claimId);
      this.#database.prepare(`
        UPDATE demands SET state = 'superseded', updated_at = ?, terminal_at = ? WHERE demand_id = ?
      `).run(now, now, demandId);
      this.#database.prepare("DELETE FROM capacity_fences WHERE claim_id = ?").run(request.claimId);
      return this.#finish(true);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #exactClaim(request: NativeHostClaimRenewalRequest): unknown {
    return this.#database.prepare(`
      SELECT * FROM claims WHERE claim_id = ? AND host_id = ? AND capacity = ?
        AND attempt_id = ? AND descriptor_digest = ?
    `).get(request.claimId, request.hostId, request.capacity, request.attemptId, request.descriptorDigest);
  }

  #hasFence(request: NativeHostClaimRenewalRequest): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM capacity_fences WHERE claim_id = ? AND host_id = ? AND capacity = ?
    `).get(request.claimId, request.hostId, request.capacity) !== undefined;
  }

  #renewal(
    request: NativeHostClaimRenewalRequest,
    leaseExpiresAt: number,
    leaseDurationMilliseconds: number
  ): NativeHostClaimRenewal {
    return {
      schemaVersion: 1,
      serviceId: this.#options.serviceId,
      requestId: request.requestId,
      claimId: request.claimId,
      leaseExpiresAt,
      leaseDurationMilliseconds
    };
  }

  #assertOwnedEpoch(): void {
    if (this.#database.prepare("SELECT 1 FROM service_epochs WHERE epoch_id = ? AND active = 1")
      .get(this.#options.ownedEpochId) === undefined) throw new NativeOrdinaryStaleAuthorityError();
  }

  #finish<T>(value: T): T {
    this.#database.exec("COMMIT");
    return value;
  }
}

function parseStoredIssuance(value: string): NativeJobAttemptIssuance {
  return parseNativeJobAttemptIssuance(JSON.parse(value));
}

function revocationMatches(issuance: NativeJobAttemptIssuance, revocation: NativeJobAttemptRevocation): boolean {
  return isDeepStrictEqual({
    attemptId: revocation.attemptId,
    reviewId: revocation.reviewId,
    jobName: revocation.jobName,
    attempt: revocation.attempt,
    descriptorDigest: revocation.descriptorDigest,
    hostId: revocation.hostId,
    capacity: revocation.capacity
  }, {
    attemptId: issuance.attemptId,
    reviewId: issuance.reviewId,
    jobName: issuance.descriptor.jobName,
    attempt: issuance.attempt,
    descriptorDigest: issuance.descriptorDigest,
    hostId: issuance.hostId,
    capacity: issuance.capacity
  });
}
