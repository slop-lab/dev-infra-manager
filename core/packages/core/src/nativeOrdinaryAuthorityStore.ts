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

export type NativeOrdinaryAuthorityClock = {
  readonly now: () => number;
};

type NativeOrdinaryAuthorityStoreOptions = {
  readonly serviceId: string;
  readonly leaseMilliseconds: number;
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
    this.#beginEpochAndExpire();
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

  admitted(input: NativeAdmissionVerification): boolean {
    this.#expire();
    const policy = this.#activePolicy(input.descriptor.admissionGeneration);
    const capacity = this.#capacity(input.hostId, input.capacity);
    return policy !== undefined && capacity !== undefined && eligible(policy, input.hostId, input.capacity)
      && descriptorMatchesPolicy(input.descriptor, policy, capacity);
  }

  assign(input: NativeAttemptAssignment): boolean {
    this.#expire();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const policy = this.#activePolicy(input.admissionGeneration);
      const capacity = this.#capacity(input.hostId, input.capacity);
      if (policy === undefined || capacity === undefined || !eligible(policy, input.hostId, input.capacity)
        || !descriptorMatchesPolicy(input.descriptor, policy, capacity)) return this.#finish(false);
      this.#database.prepare("DELETE FROM native_attempt_assignments WHERE review_id = ? AND job_name = ?")
        .run(input.reviewId, input.descriptor.jobName);
      this.#database.prepare(`
        INSERT INTO native_attempt_assignments(
          review_id, job_name, attempt_id, descriptor_digest, admission_generation, host_id, capacity
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.reviewId, input.descriptor.jobName, input.attemptId, input.descriptorDigest,
        input.admissionGeneration, input.hostId, input.capacity);
      return this.#finish(true);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  current(input: NativeAttemptVerification): boolean {
    this.#expire();
    return this.#database.prepare(`
      SELECT 1 FROM native_attempt_assignments attempts
      JOIN native_admissions admissions ON admissions.admission_generation = attempts.admission_generation
      WHERE attempts.review_id = ? AND attempts.attempt_id = ? AND attempts.descriptor_digest = ?
        AND attempts.admission_generation = ? AND attempts.host_id = ? AND attempts.capacity = ?
        AND admissions.service_id = ? AND admissions.capacity_config_digest = ?
        AND admissions.state = 'active' AND admissions.expires_at > ?
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
  }

  #beginEpochAndExpire(): void {
    const now = this.#clock.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("UPDATE service_epochs SET active = 0 WHERE active = 1").run();
      this.#database.prepare("INSERT INTO service_epochs(epoch_id, started_at, active) VALUES (?, ?, 1)")
        .run(randomUUID(), now);
      this.#expireInTransaction(now);
      this.#database.exec("COMMIT");
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
    const expired = this.#database.prepare(`
      SELECT admission_generation FROM native_admissions WHERE state = 'active' AND expires_at <= ?
    `).all(now);
    for (const row of expired) {
      const generation = stringField(row, "admission_generation");
      if (generation === undefined) throw new UserError("native ordinary database contains an invalid admission row");
      this.#invalidateGeneration(generation, "expired", now);
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

  #finish<T>(result: T): T {
    this.#database.exec("COMMIT");
    return result;
  }
}

function admissionRow(value: unknown): {
  readonly admissionGeneration: string;
  readonly policyDigest: string;
  readonly capacityConfigDigest: string;
  readonly expiresAt: number;
} | undefined {
  if (value === undefined) return undefined;
  const admissionGeneration = stringField(value, "admission_generation");
  const policyDigest = stringField(value, "policy_digest");
  const capacityConfigDigest = stringField(value, "capacity_config_digest");
  const expiresAt = numberField(value, "expires_at");
  if (admissionGeneration === undefined || policyDigest === undefined || capacityConfigDigest === undefined
    || expiresAt === undefined) throw new UserError("native ordinary database contains an invalid admission row");
  return { admissionGeneration, policyDigest, capacityConfigDigest, expiresAt };
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = Reflect.get(value, field);
  return typeof result === "string" ? result : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result = Reflect.get(value, field);
  return typeof result === "number" && Number.isSafeInteger(result) ? result : undefined;
}

function eligible(policy: NativeAdmissionPolicy, hostId: string, capacity: string): boolean {
  return policy.eligibleAssignments.some((assignment) => assignment.hostId === hostId && assignment.capacity === capacity);
}
