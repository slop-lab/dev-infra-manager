import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

const schemaVersion = 3;

export type NativeOrdinaryAuthorityClock = {
  readonly now: () => number;
};

export class NativeOrdinaryAuthorityStore {
  readonly #database: DatabaseSync;
  readonly #serviceId: string;
  readonly #leaseMilliseconds: number;
  readonly #clock: NativeOrdinaryAuthorityClock;
  readonly #capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly #capacityConfigDigest: string;

  constructor(
    file: string,
    serviceId: string,
    leaseMilliseconds: number,
    capacities: ReadonlyMap<string, NativeCapacityPolicy>,
    clock: NativeOrdinaryAuthorityClock
  ) {
    this.#database = openDatabase(file);
    this.#serviceId = serviceId;
    this.#leaseMilliseconds = leaseMilliseconds;
    this.#capacities = capacities;
    this.#capacityConfigDigest = nativeCapacityConfigDigest([...capacities.values()]);
    this.#clock = clock;
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
      const existing = admissionRow(this.#database.prepare(`
        SELECT admission_generation, policy_digest, capacity_config_digest, expires_at
        FROM native_admissions WHERE project_id = ? AND repository_id = ?
      `).get(policy.projectId, policy.repositoryId));
      const admissionGeneration = existing !== undefined && existing.expiresAt > now && existing.policyDigest === digest
        && existing.capacityConfigDigest === this.#capacityConfigDigest
        ? existing.admissionGeneration : randomUUID();
      this.#database.prepare(`
        INSERT INTO native_admissions(
          project_id, repository_id, service_id, admission_generation, policy_digest,
          capacity_config_digest, policy_json, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, repository_id) DO UPDATE SET
          service_id = excluded.service_id,
          admission_generation = excluded.admission_generation,
          policy_digest = excluded.policy_digest,
          capacity_config_digest = excluded.capacity_config_digest,
          policy_json = excluded.policy_json,
          expires_at = excluded.expires_at
      `).run(
        policy.projectId,
        policy.repositoryId,
        this.#serviceId,
        admissionGeneration,
        digest,
        this.#capacityConfigDigest,
        JSON.stringify(policy),
        expiresAt
      );
      this.#database.exec("COMMIT");
      return { admissionGeneration, expiresAt };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  revoke(projectId: string, repositoryId: string, admissionGeneration: string): boolean {
    return this.#database.prepare(`
      DELETE FROM native_admissions
      WHERE project_id = ? AND repository_id = ? AND admission_generation = ?
    `).run(projectId, repositoryId, admissionGeneration).changes === 1;
  }

  admitted(input: NativeAdmissionVerification): boolean {
    const policy = this.#activePolicy(input.descriptor.admissionGeneration);
    const capacity = this.#capacity(input.hostId, input.capacity);
    return policy !== undefined && capacity !== undefined
      && eligible(policy, input.hostId, input.capacity)
      && descriptorMatchesPolicy(input.descriptor, policy, capacity);
  }

  assign(input: NativeAttemptAssignment): boolean {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const policy = this.#activePolicy(input.admissionGeneration);
      const capacity = this.#capacity(input.hostId, input.capacity);
      if (policy === undefined || capacity === undefined || !eligible(policy, input.hostId, input.capacity)
        || !descriptorMatchesPolicy(input.descriptor, policy, capacity)) {
        this.#database.exec("ROLLBACK");
        return false;
      }
      this.#database.prepare(`
        DELETE FROM native_attempt_assignments WHERE review_id = ? AND job_name = ?
      `).run(input.reviewId, input.descriptor.jobName);
      this.#database.prepare(`
        INSERT INTO native_attempt_assignments(
          review_id, job_name, attempt_id, descriptor_digest, admission_generation, host_id, capacity
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.reviewId,
        input.descriptor.jobName,
        input.attemptId,
        input.descriptorDigest,
        input.admissionGeneration,
        input.hostId,
        input.capacity
      );
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  current(input: NativeAttemptVerification): boolean {
    const row = this.#database.prepare(`
      SELECT 1 AS authorized
      FROM native_attempt_assignments attempts
      JOIN native_admissions admissions
        ON admissions.admission_generation = attempts.admission_generation
      WHERE attempts.review_id = ? AND attempts.attempt_id = ? AND attempts.descriptor_digest = ?
        AND attempts.admission_generation = ? AND attempts.host_id = ? AND attempts.capacity = ?
        AND admissions.service_id = ? AND admissions.capacity_config_digest = ? AND admissions.expires_at > ?
    `).get(
      input.reviewId,
      input.attemptId,
      input.descriptorDigest,
      input.admissionGeneration,
      input.hostId,
      input.capacity,
      this.#serviceId,
      this.#capacityConfigDigest,
      this.#clock.now()
    );
    return row !== undefined;
  }

  #activePolicy(admissionGeneration: string): NativeAdmissionPolicy | undefined {
    const row = this.#database.prepare(`
      SELECT policy_json FROM native_admissions
      WHERE service_id = ? AND admission_generation = ? AND capacity_config_digest = ? AND expires_at > ?
    `).get(this.#serviceId, admissionGeneration, this.#capacityConfigDigest, this.#clock.now());
    if (row === undefined) return undefined;
    if (!isRecord(row) || typeof row.policy_json !== "string") throw new UserError("native ordinary database contains an invalid admission");
    let value: unknown;
    try {
      value = JSON.parse(row.policy_json);
    } catch (error) {
      if (error instanceof SyntaxError) throw new UserError("native ordinary database contains malformed admission JSON", { cause: error });
      throw error;
    }
    return parseNativeAdmissionPolicy(value);
  }

  #capacity(hostId: string, capacity: string): NativeCapacityPolicy | undefined {
    return this.#capacities.get(`${hostId}\0${capacity}`);
  }
}

function openDatabase(file: string): DatabaseSync {
  const existing = existsSync(file);
  if (existing) assertSchema(file);
  const database = new DatabaseSync(file);
  try {
    if (!existing) database.exec(`
      CREATE TABLE native_admissions (
        project_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        admission_generation TEXT NOT NULL UNIQUE,
        policy_digest TEXT NOT NULL,
        capacity_config_digest TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, repository_id)
      );
      CREATE TABLE native_attempt_assignments (
        review_id TEXT NOT NULL,
        job_name TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        descriptor_digest TEXT NOT NULL,
        admission_generation TEXT NOT NULL,
        host_id TEXT NOT NULL,
        capacity TEXT NOT NULL,
        PRIMARY KEY(review_id, job_name)
      );
      PRAGMA user_version = ${schemaVersion};
    `);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertSchema(file: string): void {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA user_version").get();
    if (!isRecord(row) || row.user_version !== schemaVersion) {
      throw new UserError(`native ordinary database schema version is unsupported; expected ${schemaVersion}`);
    }
  } finally {
    database.close();
  }
}

function admissionRow(value: unknown): {
  readonly admissionGeneration: string;
  readonly policyDigest: string;
  readonly capacityConfigDigest: string;
  readonly expiresAt: number;
} | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.admission_generation !== "string" || typeof value.policy_digest !== "string"
    || typeof value.capacity_config_digest !== "string"
    || !Number.isSafeInteger(value.expires_at)) throw new UserError("native ordinary database contains an invalid admission row");
  return {
    admissionGeneration: value.admission_generation,
    policyDigest: value.policy_digest,
    capacityConfigDigest: value.capacity_config_digest,
    expiresAt: Number(value.expires_at)
  };
}

function eligible(policy: NativeAdmissionPolicy, hostId: string, capacity: string): boolean {
  return policy.eligibleAssignments.some((assignment) => assignment.hostId === hostId && assignment.capacity === capacity);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
