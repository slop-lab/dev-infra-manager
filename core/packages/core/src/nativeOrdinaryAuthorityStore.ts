import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import {
  descriptorMatchesPolicy,
  nativeCapacityConfigDigest,
  nativePolicyDigest,
  parseNativeAdmissionPolicy,
  type NativeAdmissionPolicy,
  type NativeAdmissionVerification,
  type NativeAttemptAssignment,
  type NativeAttemptVerification,
  type NativeCapacityPolicy
} from "./nativeOrdinaryAuthorityModel.js";
import { openNativeOrdinaryDatabase } from "./nativeOrdinaryAuthoritySchema.js";
import { NativeOrdinaryEventStore, type NativeEventIntakeResult } from "./nativeOrdinaryEventStore.js";
import type { NativeReviewJobEvent } from "./nativeOrdinaryEvent.js";
import {
  NativeOrdinaryClaimStore,
  type NativeClaimActivation,
  type NativeClaimReservation
} from "./nativeOrdinaryClaimStore.js";
import type { NativeHostClaimRequest } from "./nativeOrdinaryClaimProtocol.js";
import { admissionRow, numberField, stringField } from "./nativeOrdinaryAuthorityRows.js";
import { fenceExpiredClaims, fenceGenerationClaims, fenceRestartedClaims } from "./nativeOrdinaryFencing.js";

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
  readonly #capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly #capacityConfigDigest: string;
  readonly #eventStore: NativeOrdinaryEventStore;
  readonly #claimStore: NativeOrdinaryClaimStore;

  constructor(file: string, options: NativeOrdinaryAuthorityStoreOptions) {
    this.#database = openNativeOrdinaryDatabase(file);
    this.#serviceId = options.serviceId;
    this.#leaseMilliseconds = options.leaseMilliseconds;
    this.#capacities = options.capacities;
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
    assignment: NativeAttemptAssignment
  ): NativeClaimActivation {
    return this.#claimStore.activate(request, reservation, assignment);
  }

  releaseStaleClaim(request: NativeHostClaimRequest, claimId: string): void {
    this.#claimStore.releaseStale(request, claimId);
  }

  admitted(input: NativeAdmissionVerification): boolean {
    this.#expire();
    const policy = this.#activePolicy(input.descriptor.admissionGeneration);
    const capacity = this.#capacity(input.hostId, input.capacity);
    return policy !== undefined && capacity !== undefined
      && descriptorMatchesPolicy(input.descriptor, policy, capacity);
  }

  current(input: NativeAttemptVerification): boolean {
    this.#expire();
    return this.#database.prepare(`
      SELECT 1 FROM native_attempt_assignments attempts
      JOIN native_admissions admissions ON admissions.admission_generation = attempts.admission_generation
      JOIN claims ON claims.claim_id = attempts.claim_id
      WHERE attempts.review_id = ? AND attempts.attempt_id = ? AND attempts.descriptor_digest = ?
        AND attempts.admission_generation = ? AND attempts.host_id = ? AND attempts.capacity = ?
        AND admissions.service_id = ? AND admissions.capacity_config_digest = ?
        AND admissions.state = 'active' AND admissions.expires_at > ? AND claims.state = 'active'
    `).get(input.reviewId, input.attemptId, input.descriptorDigest, input.admissionGeneration,
      input.hostId, input.capacity, this.#serviceId, this.#capacityConfigDigest, this.#clock.now()) !== undefined;
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

  #activePolicy(admissionGeneration: string): NativeAdmissionPolicy | undefined {
    const row = this.#database.prepare(`
      SELECT policy_json FROM native_admissions
      WHERE service_id = ? AND admission_generation = ? AND capacity_config_digest = ?
        AND state = 'active' AND expires_at > ?
    `).get(this.#serviceId, admissionGeneration, this.#capacityConfigDigest, this.#clock.now());
    const policyJson = stringField(row, "policy_json");
    if (policyJson === undefined) return undefined;
    try {
      return parseNativeAdmissionPolicy(JSON.parse(policyJson));
    } catch (error) {
      if (error instanceof SyntaxError) throw new UserError("native ordinary database contains malformed admission JSON", { cause: error });
      throw error;
    }
  }

  #capacity(hostId: string, capacity: string): NativeCapacityPolicy | undefined {
    return this.#capacities.get(`${hostId}\0${capacity}`);
  }

}
