import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import {
  descriptorMatchesPolicy,
  parseNativeAdmissionPolicy,
  type NativeAdmissionPolicy,
  type NativeAdmissionVerification,
  type NativeAttemptVerification,
  type NativeCapacityPolicy
} from "./nativeOrdinaryAuthorityModel.js";
import { stringField } from "./nativeOrdinaryAuthorityRows.js";

type VerificationStoreOptions = {
  readonly serviceId: string;
  readonly capacityConfigDigest: string;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly now: () => number;
};

export class NativeOrdinaryVerificationStore {
  readonly #database: DatabaseSync;
  readonly #options: VerificationStoreOptions;

  constructor(database: DatabaseSync, options: VerificationStoreOptions) {
    this.#database = database;
    this.#options = options;
  }

  admitted(input: NativeAdmissionVerification): boolean {
    const policy = this.#activePolicy(input.descriptor.admissionGeneration);
    const capacity = this.#options.capacities.get(`${input.hostId}\0${input.capacity}`);
    return policy !== undefined && capacity !== undefined
      && descriptorMatchesPolicy(input.descriptor, policy, capacity);
  }

  current(input: NativeAttemptVerification): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM native_attempt_assignments attempts
      JOIN native_admissions admissions ON admissions.admission_generation = attempts.admission_generation
      JOIN claims ON claims.claim_id = attempts.claim_id
      WHERE attempts.review_id = ? AND attempts.attempt_id = ? AND attempts.descriptor_digest = ?
        AND attempts.admission_generation = ? AND attempts.host_id = ? AND attempts.capacity = ?
        AND admissions.service_id = ? AND admissions.capacity_config_digest = ?
        AND admissions.state = 'active' AND admissions.expires_at > ? AND claims.state = 'active'
    `).get(input.reviewId, input.attemptId, input.descriptorDigest, input.admissionGeneration,
      input.hostId, input.capacity, this.#options.serviceId, this.#options.capacityConfigDigest,
      this.#options.now()) !== undefined;
  }

  #activePolicy(admissionGeneration: string): NativeAdmissionPolicy | undefined {
    const row = this.#database.prepare(`
      SELECT policy_json FROM native_admissions
      WHERE service_id = ? AND admission_generation = ? AND capacity_config_digest = ?
        AND state = 'active' AND expires_at > ?
    `).get(this.#options.serviceId, admissionGeneration, this.#options.capacityConfigDigest, this.#options.now());
    const policyJson = stringField(row, "policy_json");
    if (policyJson === undefined) return undefined;
    try {
      return parseNativeAdmissionPolicy(JSON.parse(policyJson));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new UserError("native ordinary database contains malformed admission JSON", { cause: error });
      }
      throw error;
    }
  }
}
