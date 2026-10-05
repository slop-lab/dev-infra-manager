import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import type { NativeAttemptAssignment, NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import { descriptorMatchesPolicy } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import type { NativeReviewJobEvent } from "./nativeOrdinaryEvent.js";
import type { NativeHostClaim, NativeHostClaimRequest } from "./nativeOrdinaryClaimProtocol.js";
import { parseStoredEvent, parseStoredPolicy } from "./nativeOrdinaryClaimProtocol.js";
import { loadActiveNativeHostClaim } from "./nativeOrdinaryClaimRecord.js";
import { requiredClaimString, stringField } from "./nativeOrdinaryAuthorityRows.js";

export type NativeClaimReservation =
  | { readonly kind: "empty" }
  | { readonly kind: "conflict" }
  | { readonly kind: "active"; readonly claim: NativeHostClaim }
  | {
      readonly kind: "preparing";
      readonly claimId: string;
      readonly epochId: string;
      readonly event: NativeReviewJobEvent;
      readonly admissionGeneration: string;
      readonly capacity: NativeCapacityPolicy;
    };
export type NativeClaimActivation =
  | { readonly kind: "active"; readonly claim: NativeHostClaim }
  | { readonly kind: "conflict" };
export type NativeClaimActivationProof = {
  readonly assignment: NativeAttemptAssignment;
  readonly issuance: NativeJobAttemptIssuance;
};

type ClaimStoreOptions = {
  readonly serviceId: string;
  readonly ownedEpochId: string;
  readonly capacityConfigDigest: string;
  readonly claimLeaseMilliseconds: number;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly now: () => number;
};

export class NativeOrdinaryStaleAuthorityError extends UserError {
  readonly name = "NativeOrdinaryStaleAuthorityError";

  constructor() {
    super("native ordinary authority service epoch is no longer active");
  }
}

type ReceiptInput = {
  readonly claimId: string;
  readonly request: NativeHostClaimRequest;
  readonly demandId: string | null;
  readonly generation: string | null;
  readonly state: "empty" | "preparing";
  readonly now: number;
};

export class NativeOrdinaryClaimStore {
  readonly #database: DatabaseSync;
  readonly #options: ClaimStoreOptions;

  constructor(database: DatabaseSync, options: ClaimStoreOptions) {
    this.#database = database;
    this.#options = options;
  }

  reserve(request: NativeHostClaimRequest): NativeClaimReservation {
    const now = this.#options.now();
    const capacity = this.#options.capacities.get(`${request.hostId}\0${request.capacity}`);
    if (capacity === undefined) return { kind: "conflict" };
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertOwnedEpoch();
      const existing = this.#database.prepare(`
        SELECT claim_id, state FROM claim_receipts WHERE host_id = ? AND capacity = ? AND request_id = ?
      `).get(request.hostId, request.capacity, request.requestId);
      if (existing !== undefined) return this.#finish(this.#existing(request, capacity, existing));
      if (this.#database.prepare(`
        SELECT 1 FROM claim_receipts
        WHERE host_id = ? AND capacity = ? AND state IN ('preparing','active','reported','recovering')
      `).get(request.hostId, request.capacity) !== undefined
        || this.#database.prepare("SELECT 1 FROM capacity_fences WHERE host_id = ? AND capacity = ?")
          .get(request.hostId, request.capacity) !== undefined) {
        return this.#finish({ kind: "conflict" });
      }
      const demand = this.#database.prepare(`
        SELECT demands.demand_id, demands.event_id, demands.admission_generation, inbox.event_json
        FROM demands JOIN native_event_inbox inbox ON inbox.event_id = demands.event_id
        JOIN native_admissions admissions ON admissions.admission_generation = demands.admission_generation
        WHERE demands.state = 'queued' AND admissions.service_id = ? AND admissions.state = 'active'
          AND admissions.expires_at > ? AND admissions.capacity_config_digest = ?
        ORDER BY demands.created_at, demands.demand_id LIMIT 1
      `).get(this.#options.serviceId, now, this.#options.capacityConfigDigest);
      const claimId = randomUUID();
      if (demand === undefined) {
        this.#insertReceipt({ claimId, request, demandId: null, generation: null, state: "empty", now });
        return this.#finish({ kind: "empty" });
      }
      const demandId = requiredClaimString(demand, "demand_id");
      const event = parseStoredEvent(requiredClaimString(demand, "event_json"));
      const admissionGeneration = requiredClaimString(demand, "admission_generation");
      this.#insertReceipt({ claimId, request, demandId, generation: admissionGeneration, state: "preparing", now });
      this.#database.prepare("UPDATE demands SET state = 'preparing', updated_at = ? WHERE demand_id = ? AND state = 'queued'")
        .run(now, demandId);
      return this.#finish({
        kind: "preparing",
        claimId,
        epochId: this.#options.ownedEpochId,
        event,
        admissionGeneration,
        capacity
      });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  activate(
    request: NativeHostClaimRequest,
    reservation: Extract<NativeClaimReservation, { readonly kind: "preparing" }>,
    proof: NativeClaimActivationProof
  ): NativeClaimActivation {
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertOwnedEpoch();
      const receipt = this.#database.prepare(`
        SELECT state, demand_id, admission_generation FROM claim_receipts
        WHERE claim_id = ? AND host_id = ? AND capacity = ? AND request_id = ?
      `).get(reservation.claimId, request.hostId, request.capacity, request.requestId);
      const state = stringField(receipt, "state");
      if (state === "active") return this.#finish({ kind: "active", claim: this.#loadActive(request, reservation.claimId) });
      if (state !== "preparing" || stringField(receipt, "admission_generation") !== reservation.admissionGeneration
        || reservation.epochId !== this.#options.ownedEpochId || !this.#ownsActiveEpoch()
        || !this.#assignmentMatches(proof.assignment, reservation)
        || proof.issuance.issuanceRequestId !== reservation.claimId) {
        return this.#finish({ kind: "conflict" });
      }
      const policyRow = this.#database.prepare(`
        SELECT policy_json FROM native_admissions WHERE admission_generation = ? AND service_id = ?
          AND state = 'active' AND expires_at > ? AND capacity_config_digest = ?
      `).get(reservation.admissionGeneration, this.#options.serviceId, now, this.#options.capacityConfigDigest);
      const policyJson = stringField(policyRow, "policy_json");
      const demandId = stringField(receipt, "demand_id");
      if (policyJson === undefined || demandId === undefined
        || !descriptorMatchesPolicy(proof.assignment.descriptor, parseStoredPolicy(policyJson), reservation.capacity)
        || this.#database.prepare("SELECT 1 FROM demands WHERE demand_id = ? AND state = 'preparing'").get(demandId) === undefined) {
        return this.#finish({ kind: "conflict" });
      }
      const leaseExpiresAt = now + this.#options.claimLeaseMilliseconds;
      this.#database.prepare(`
        INSERT INTO claims(claim_id, demand_id, host_id, capacity, event_id, review_id, job_name,
          admission_generation, attempt_id, descriptor_json, descriptor_digest, issuance_json, lease_expires_at,
          service_epoch_id, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(reservation.claimId, demandId, request.hostId, request.capacity, reservation.event.eventId,
        proof.assignment.reviewId, reservation.event.jobName, reservation.admissionGeneration, proof.assignment.attemptId,
        JSON.stringify(proof.assignment.descriptor), proof.assignment.descriptorDigest,
        JSON.stringify(proof.issuance), leaseExpiresAt,
        reservation.epochId);
      this.#database.prepare(`
        INSERT INTO native_attempt_assignments(
          review_id, job_name, claim_id, attempt_id, descriptor_digest, admission_generation, host_id, capacity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(proof.assignment.reviewId, reservation.event.jobName, reservation.claimId, proof.assignment.attemptId,
        proof.assignment.descriptorDigest, reservation.admissionGeneration, request.hostId, request.capacity);
      this.#database.prepare("UPDATE claim_receipts SET state = 'active', updated_at = ? WHERE claim_id = ?")
        .run(now, reservation.claimId);
      this.#database.prepare("UPDATE demands SET state = 'claimed', updated_at = ? WHERE demand_id = ?")
        .run(now, demandId);
      return this.#finish({ kind: "active", claim: this.#loadActive(request, reservation.claimId) });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseStale(request: NativeHostClaimRequest, claimId: string): void {
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`
        SELECT demand_id FROM claim_receipts
        WHERE claim_id = ? AND host_id = ? AND capacity = ? AND request_id = ? AND state = 'preparing'
      `).get(claimId, request.hostId, request.capacity, request.requestId);
      const demandId = stringField(row, "demand_id");
      if (demandId !== undefined) {
        this.#database.prepare("UPDATE demands SET state = 'superseded', updated_at = ?, terminal_at = ? WHERE demand_id = ?")
          .run(now, now, demandId);
        this.#database.prepare("UPDATE claim_receipts SET state = 'released', updated_at = ?, released_at = ? WHERE claim_id = ?")
          .run(now, now, claimId);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #existing(request: NativeHostClaimRequest, capacity: NativeCapacityPolicy, row: unknown): NativeClaimReservation {
    const claimId = requiredClaimString(row, "claim_id");
    const state = requiredClaimString(row, "state");
    if (state === "empty") return { kind: "empty" };
    if (state === "active") return { kind: "active", claim: this.#loadActive(request, claimId) };
    if (state !== "preparing") return { kind: "conflict" };
    const preparing = this.#database.prepare(`
      SELECT receipts.admission_generation, inbox.event_json
      FROM claim_receipts receipts JOIN demands ON demands.demand_id = receipts.demand_id
      JOIN native_event_inbox inbox ON inbox.event_id = demands.event_id WHERE receipts.claim_id = ?
    `).get(claimId);
    return {
      kind: "preparing",
      claimId,
      epochId: this.#options.ownedEpochId,
      event: parseStoredEvent(requiredClaimString(preparing, "event_json")),
      admissionGeneration: requiredClaimString(preparing, "admission_generation"),
      capacity
    };
  }

  #loadActive(request: NativeHostClaimRequest, claimId: string): NativeHostClaim {
    return loadActiveNativeHostClaim({
      database: this.#database,
      serviceId: this.#options.serviceId,
      request,
      claimId,
    });
  }

  #assignmentMatches(assignment: NativeAttemptAssignment, reservation: Extract<NativeClaimReservation, { readonly kind: "preparing" }>): boolean {
    return assignment.reviewId === reservation.event.reviewId
      && assignment.descriptor.jobName === reservation.event.jobName
      && assignment.admissionGeneration === reservation.admissionGeneration
      && assignment.hostId === reservation.capacity.hostId
      && assignment.capacity === reservation.capacity.capacity;
  }

  #insertReceipt(input: ReceiptInput): void {
    this.#database.prepare(`
      INSERT INTO claim_receipts(claim_id, host_id, capacity, request_id, demand_id,
        admission_generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.claimId, input.request.hostId, input.request.capacity, input.request.requestId,
      input.demandId, input.generation, input.state, input.now, input.now);
  }

  #assertOwnedEpoch(): void {
    if (!this.#ownsActiveEpoch()) throw new NativeOrdinaryStaleAuthorityError();
  }

  #ownsActiveEpoch(): boolean {
    return this.#database.prepare("SELECT 1 FROM service_epochs WHERE epoch_id = ? AND active = 1")
      .get(this.#options.ownedEpochId) !== undefined;
  }

  #finish<T>(value: T): T {
    this.#database.exec("COMMIT");
    return value;
  }
}
