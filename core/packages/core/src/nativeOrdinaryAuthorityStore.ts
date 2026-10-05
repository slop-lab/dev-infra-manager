import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import {
  nativeCapacityConfigDigest,
  nativePolicyDigest,
  type NativeAdmissionPolicy,
  type NativeAdmissionVerification,
  type NativeAttemptVerification,
  type NativeCapacityPolicy
} from "./nativeOrdinaryAuthorityModel.js";
import { openNativeOrdinaryDatabase } from "./nativeOrdinaryAuthoritySchema.js";
import { NativeOrdinaryEventStore, type NativeEventIntakeResult } from "./nativeOrdinaryEventStore.js";
import type { NativeReviewJobEvent } from "./nativeOrdinaryEvent.js";
import {
  NativeOrdinaryClaimStore,
  type NativeClaimActivation,
  type NativeClaimActivationProof,
  type NativeClaimReservation
} from "./nativeOrdinaryClaimStore.js";
import type { NativeHostClaimRequest } from "./nativeOrdinaryClaimProtocol.js";
import type { NativeJobAttemptRevocation } from "./nativeGitAttemptIssuerModel.js";
import type {
  NativeHostClaimRenewal,
  NativeHostClaimRenewalRequest,
  NativeHostRecoveryRequest
} from "./nativeOrdinaryClaimProtocol.js";
import { admissionRow, numberField, stringField } from "./nativeOrdinaryAuthorityRows.js";
import { fenceExpiredClaims, fenceGenerationClaims, fenceRestartedClaims } from "./nativeOrdinaryFencing.js";
import { NativeOrdinaryLeaseStore, type NativeRecoveryPreparation } from "./nativeOrdinaryLeaseStore.js";
import { NativeOrdinaryVerificationStore } from "./nativeOrdinaryVerificationStore.js";

export type NativeOrdinaryAuthorityClock = {
  readonly now: () => number;
};

type NativeOrdinaryAuthorityStoreOptions = {
  readonly serviceId: string;
  readonly leaseMilliseconds: number;
  readonly claimLeaseMilliseconds: number;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly clock: NativeOrdinaryAuthorityClock;
};

export class NativeOrdinaryAuthorityStore {
  readonly #database: DatabaseSync;
  readonly #serviceId: string;
  readonly #leaseMilliseconds: number;
  readonly #clock: NativeOrdinaryAuthorityClock;
  readonly #capacityConfigDigest: string;
  readonly #eventStore: NativeOrdinaryEventStore;
  readonly #claimStore: NativeOrdinaryClaimStore;
  readonly #leaseStore: NativeOrdinaryLeaseStore;
  readonly #verificationStore: NativeOrdinaryVerificationStore;

  constructor(file: string, options: NativeOrdinaryAuthorityStoreOptions) {
    this.#database = openNativeOrdinaryDatabase(file);
    this.#serviceId = options.serviceId;
    this.#leaseMilliseconds = options.leaseMilliseconds;
    this.#capacityConfigDigest = nativeCapacityConfigDigest([...options.capacities.values()]);
    this.#clock = options.clock;
    this.#eventStore = new NativeOrdinaryEventStore(this.#database, {
      serviceId: options.serviceId,
      capacityConfigDigest: this.#capacityConfigDigest,
      now: options.clock.now
    });
    const ownedEpochId = this.#beginEpochAndExpire();
    this.#claimStore = new NativeOrdinaryClaimStore(this.#database, {
      serviceId: options.serviceId,
      ownedEpochId,
      capacityConfigDigest: this.#capacityConfigDigest,
      claimLeaseMilliseconds: options.claimLeaseMilliseconds,
      capacities: options.capacities,
      now: options.clock.now
    });
    this.#leaseStore = new NativeOrdinaryLeaseStore(this.#database, {
      serviceId: options.serviceId,
      ownedEpochId,
      claimLeaseMilliseconds: options.claimLeaseMilliseconds,
      now: options.clock.now
    });
    this.#verificationStore = new NativeOrdinaryVerificationStore(this.#database, {
      serviceId: options.serviceId,
      capacityConfigDigest: this.#capacityConfigDigest,
      capacities: options.capacities,
      now: options.clock.now
    });
  }

  close(): void {
    this.#database.close();
  }

  admit(policy: NativeAdmissionPolicy): { readonly admissionGeneration: string; readonly expiresAt: number } {
    const now = this.#clock.now();
    const expiresAt = now + this.#leaseMilliseconds;
    const digest = nativePolicyDigest(policy);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expireInTransaction(now);
      const existing = admissionRow(this.#database.prepare(`
        SELECT admission_generation, policy_digest, capacity_config_digest, expires_at
        FROM native_admissions WHERE project_id = ? AND repository_id = ? AND state = 'active'
      `).get(policy.projectId, policy.repositoryId));
      const reusable = existing !== undefined && existing.expiresAt > now && existing.policyDigest === digest
        && existing.capacityConfigDigest === this.#capacityConfigDigest;
      if (reusable) {
        this.#database.prepare(`
          UPDATE native_admissions SET policy_json = ?, expires_at = ?, updated_at = ? WHERE admission_generation = ?
        `).run(JSON.stringify(policy), expiresAt, now, existing.admissionGeneration);
        this.#database.exec("COMMIT");
        return { admissionGeneration: existing.admissionGeneration, expiresAt };
      }
      if (existing !== undefined) this.#invalidateGeneration(existing.admissionGeneration, existing.expiresAt <= now ? "expired" : "replaced", now);
      const admissionGeneration = randomUUID();
      this.#database.prepare(`
        INSERT INTO native_admissions(
          admission_generation, project_id, repository_id, service_id, protected_ref, policy_revision,
          required_review_revision, required_job_set_revision, policy_digest, capacity_config_digest,
          policy_json, expires_at, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        admissionGeneration, policy.projectId, policy.repositoryId, this.#serviceId, policy.protectedRef,
        policy.policyRevision, policy.requiredReviewRevision, policy.requiredJobSetRevision, digest,
        this.#capacityConfigDigest, JSON.stringify(policy), expiresAt, now, now
      );
      this.#database.exec("COMMIT");
      return { admissionGeneration, expiresAt };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  revoke(projectId: string, repositoryId: string, admissionGeneration: string): boolean {
    const now = this.#clock.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expireInTransaction(now);
      const active = this.#database.prepare(`
        SELECT 1 FROM native_admissions
        WHERE project_id = ? AND repository_id = ? AND admission_generation = ? AND state = 'active'
      `).get(projectId, repositoryId, admissionGeneration);
      if (active === undefined) {
        this.#database.exec("ROLLBACK");
        return false;
      }
      this.#invalidateGeneration(admissionGeneration, "revoked", now);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  checkEventReplay(event: NativeReviewJobEvent): NativeEventIntakeResult {
    this.#expire();
    return this.#eventStore.checkReplay(event);
  }

  acceptEvent(event: NativeReviewJobEvent): NativeEventIntakeResult {
    this.#expire();
    return this.#eventStore.accept(event);
  }

  reserveClaim(request: NativeHostClaimRequest): NativeClaimReservation {
    this.#expire();
    return this.#claimStore.reserve(request);
  }

  activateClaim(
    request: NativeHostClaimRequest,
    reservation: Extract<NativeClaimReservation, { readonly kind: "preparing" }>,
    proof: NativeClaimActivationProof
  ): NativeClaimActivation {
    return this.#claimStore.activate(request, reservation, proof);
  }

  releaseStaleClaim(request: NativeHostClaimRequest, claimId: string): void {
    this.#claimStore.releaseStale(request, claimId);
  }

  renewClaim(request: NativeHostClaimRenewalRequest): NativeHostClaimRenewal | undefined {
    this.#expire();
    return this.#leaseStore.renew(request);
  }

  prepareRecovery(request: NativeHostRecoveryRequest): NativeRecoveryPreparation {
    this.#expire();
    return this.#leaseStore.prepareRecovery(request);
  }

  completeRecovery(request: NativeHostRecoveryRequest, proof: NativeJobAttemptRevocation): boolean {
    return this.#leaseStore.completeRecovery(request, proof);
  }

  admitted(input: NativeAdmissionVerification): boolean {
    this.#expire();
    return this.#verificationStore.admitted(input);
  }

  current(input: NativeAttemptVerification): boolean {
    this.#expire();
    return this.#verificationStore.current(input);
  }

  #invalidateGeneration(generation: string, state: "expired" | "revoked" | "replaced", now: number): void {
    this.#database.prepare("UPDATE native_admissions SET state = ?, updated_at = ? WHERE admission_generation = ?")
      .run(state, now, generation);
    this.#database.prepare(`
      UPDATE demands SET state = 'superseded', updated_at = ?, terminal_at = ?
      WHERE admission_generation = ? AND state = 'queued'
    `).run(now, now, generation);
    fenceGenerationClaims(this.#database, generation, now);
  }

  #beginEpochAndExpire(): string {
    const now = this.#clock.now();
    const epochId = randomUUID();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("UPDATE service_epochs SET active = 0 WHERE active = 1").run();
      fenceRestartedClaims(this.#database, now);
      this.#database.prepare("INSERT INTO service_epochs(epoch_id, started_at, active) VALUES (?, ?, 1)")
        .run(epochId, now);
      this.#expireInTransaction(now);
      this.#database.exec("COMMIT");
      return epochId;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #expire(): void {
    const now = this.#clock.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expireInTransaction(now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #expireInTransaction(now: number): void {
    fenceExpiredClaims(this.#database, now);
    const expired = this.#database.prepare(`
      SELECT admission_generation FROM native_admissions
      WHERE state = 'active' AND (expires_at <= ? OR capacity_config_digest <> ?)
    `).all(now, this.#capacityConfigDigest);
    for (const row of expired) {
      const generation = stringField(row, "admission_generation");
      if (generation === undefined) throw new UserError("native ordinary database contains an invalid admission row");
      const expiresAt = numberField(this.#database.prepare(
        "SELECT expires_at FROM native_admissions WHERE admission_generation = ?"
      ).get(generation), "expires_at");
      this.#invalidateGeneration(generation, expiresAt !== undefined && expiresAt <= now ? "expired" : "replaced", now);
    }
  }

}
