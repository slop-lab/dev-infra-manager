import type { DatabaseSync } from "node:sqlite";
import {
  parseNativeJobAttemptRevocation,
  type NativeJobAttemptRevocation
} from "./nativeGitAttemptIssuerModel.js";
import type { NativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import {
  type NativeRootCiActiveClaim,
  type NativeRootCiClaimActivationRequest,
  type NativeRootCiClaimLeaseRequest,
  type NativeRootCiClaimRecoveryRequest
} from "./nativeRootCiClaimLifecycleProtocol.js";
import {
  lifecycleInteger as numeric,
  lifecycleText as field,
  NativeRootCiClaimLifecycleStoreError,
  parseStoredActiveClaim as parseActiveClaim,
  parseStoredAssignment as parseAssignment,
  parseStoredIssuance as parseIssuance
} from "./nativeRootCiClaimLifecycleRows.js";

type LifecycleStoreContext = {
  readonly serviceId: string; readonly generationId: string;
  readonly serviceEpochId: string;
  readonly leaseMilliseconds: number;
  readonly now: () => number;
};

export type ActivationReplay = | { readonly kind: "none" | "conflict" }
  | { readonly kind: "replay"; readonly response: NativeRootCiActiveClaim };
export type ActivationResult = | { readonly kind: "created"; readonly response: NativeRootCiActiveClaim }
  | { readonly kind: "conflict" };
export type RecoveryPreparation = | { readonly kind: "conflict" | "released" }
  | { readonly kind: "pending"; readonly request: NativeRootCiClaimRecoveryRequest };
export type RecoveryReplay = | { readonly kind: "none" | "conflict" | "released" }
  | { readonly kind: "pending"; readonly request: NativeRootCiClaimRecoveryRequest };

export class NativeRootCiClaimLifecycleStore {
  constructor(readonly database: DatabaseSync, readonly context: LifecycleStoreContext) {}

  activationReplay(request: NativeRootCiClaimActivationRequest): ActivationReplay {
    const row = this.database.prepare(`SELECT activation_request_id, issuance_json, response_json
      FROM native_root_ci_claim_receipts WHERE claim_id = ?`).get(request.claim.claimId);
    if (row === undefined) return { kind: "none" };
    if (field(row, "activation_request_id") !== request.requestId
      || field(row, "issuance_json") !== JSON.stringify(request.issuance)) return { kind: "conflict" };
    const response = field(row, "response_json");
    return response === undefined ? { kind: "conflict" } : { kind: "replay", response: parseActiveClaim(response) };
  }

  activationEligible(request: NativeRootCiClaimActivationRequest): boolean {
    const stored = this.claimRow(request.claim.claimId);
    return request.generationId === this.context.generationId && request.claim.serviceEpochId === this.context.serviceEpochId
      && this.currentEpoch() && stored !== undefined && field(stored, "state") === "preparing"
      && field(stored, "response_json") === JSON.stringify(request.claim) && this.currentReservation(request.claim.claimId);
  }

  activate(request: NativeRootCiClaimActivationRequest, assignment: NativeAttemptAssignment): ActivationResult {
    return this.transaction(() => {
      if (!this.currentEpoch() || request.generationId !== this.context.generationId
        || request.claim.serviceEpochId !== this.context.serviceEpochId) return { kind: "conflict" };
      const stored = this.claimRow(request.claim.claimId);
      if (stored === undefined || field(stored, "state") !== "preparing"
        || field(stored, "response_json") !== JSON.stringify(request.claim)
        || !this.currentReservation(request.claim.claimId)) return { kind: "conflict" };
      if (this.database.prepare("SELECT 1 FROM native_root_ci_claim_receipts WHERE claim_id = ?")
        .get(request.claim.claimId) !== undefined) return { kind: "conflict" };
      const now = this.context.now();
      const leaseExpiresAt = now + this.context.leaseMilliseconds;
      const response: NativeRootCiActiveClaim = {
        schemaVersion: 1, serviceId: this.context.serviceId, generationId: this.context.generationId,
        serviceEpochId: this.context.serviceEpochId, requestId: request.requestId, claimId: request.claim.claimId,
        assignment, issuance: request.issuance, leaseExpiresAt,
        leaseDurationMilliseconds: this.context.leaseMilliseconds
      };
      this.database.prepare(`INSERT INTO native_root_ci_claim_receipts
        (claim_id, activation_request_id, attempt_id, descriptor_digest, assignment_json, issuance_json,
          response_json, lease_expires_at, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
        request.claim.claimId, request.requestId, request.issuance.attemptId, request.issuance.descriptorDigest,
        JSON.stringify(assignment), JSON.stringify(request.issuance), JSON.stringify(response), leaseExpiresAt, now, now);
      this.database.prepare("UPDATE native_root_ci_claims SET state = 'active', updated_at = ? WHERE claim_id = ?")
        .run(now, request.claim.claimId);
      this.database.prepare("UPDATE native_root_ci_demands SET state = 'active', updated_at = ? WHERE demand_id = ?")
        .run(now, request.claim.demandId);
      return { kind: "created", response };
    });
  }

  renew(request: NativeRootCiClaimLeaseRequest): NativeRootCiActiveClaim | undefined {
    return this.transaction(() => {
      const row = this.database.prepare(`SELECT c.service_epoch_id, c.generation_id, c.host_id, c.capacity,
        c.state claim_state, r.state receipt_state, r.attempt_id, r.descriptor_digest, r.assignment_json,
        r.issuance_json, r.lease_expires_at
        FROM native_root_ci_claims c JOIN native_root_ci_claim_receipts r ON r.claim_id = c.claim_id
        JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
        JOIN native_root_ci_event_receipts e
          ON e.admission_generation = d.admission_generation AND e.event_id = d.event_id
        JOIN native_root_admissions a ON a.admission_generation = c.admission_generation
        WHERE c.claim_id = ? AND d.state = 'active' AND a.state = 'active'
          AND a.control_plane_generation_id = c.generation_id
          AND a.capacity_config_digest = c.capacity_config_digest
          AND a.root_sequence = e.root_sequence AND a.root_commit = e.root_commit
          AND a.root_tree = e.root_tree AND a.policy_digest = e.policy_digest`).get(
        request.claimId);
      if (row === undefined || !this.currentEpoch() || request.generationId !== this.context.generationId
        || field(row, "service_epoch_id") !== this.context.serviceEpochId
        || field(row, "generation_id") !== this.context.generationId || field(row, "host_id") !== request.hostId
        || field(row, "capacity") !== request.capacity || field(row, "claim_state") !== "active"
        || field(row, "receipt_state") !== "active" || field(row, "attempt_id") !== request.attemptId
        || field(row, "descriptor_digest") !== request.descriptorDigest
        || numeric(row, "lease_expires_at") <= this.context.now()) return undefined;
      const leaseExpiresAt = this.context.now() + this.context.leaseMilliseconds;
      const assignmentJson = field(row, "assignment_json");
      const issuanceJson = field(row, "issuance_json");
      if (assignmentJson === undefined || issuanceJson === undefined) return undefined;
      this.database.prepare(`UPDATE native_root_ci_claim_receipts SET lease_expires_at = ?, updated_at = ?
        WHERE claim_id = ?`).run(leaseExpiresAt, this.context.now(), request.claimId);
      return { schemaVersion: 1, serviceId: this.context.serviceId, generationId: this.context.generationId,
        serviceEpochId: this.context.serviceEpochId, requestId: request.requestId, claimId: request.claimId,
        assignment: parseAssignment(assignmentJson),
        issuance: parseIssuance(issuanceJson), leaseExpiresAt,
        leaseDurationMilliseconds: this.context.leaseMilliseconds };
    });
  }

  recoveryReplay(request: NativeRootCiClaimRecoveryRequest): RecoveryReplay {
    const row = this.database.prepare(`SELECT state, recovery_request_id, assignment_json, issuance_json
      FROM native_root_ci_claim_receipts WHERE claim_id = ?`).get(request.claimId);
    if (row === undefined || field(row, "state") === "active" || field(row, "state") === "reported") {
      return { kind: "none" };
    }
    if (field(row, "recovery_request_id") !== request.requestId
      || field(row, "issuance_json") !== JSON.stringify(request.issuance)) return { kind: "conflict" };
    if (field(row, "state") === "released") return { kind: "released" };
    if (field(row, "state") !== "recovering") return { kind: "conflict" };
    return { kind: "pending", request };
  }

  recoveryEligible(request: NativeRootCiClaimRecoveryRequest): boolean {
    const claim = this.claimRow(request.claimId);
    return request.generationId === this.context.generationId && request.resourceId === request.claimId
      && claim !== undefined && field(claim, "response_json") === JSON.stringify(request.claim)
      && field(claim, "host_id") === request.hostId && field(claim, "capacity") === request.capacity;
  }

  prepareRecovery(request: NativeRootCiClaimRecoveryRequest, assignment: NativeAttemptAssignment): RecoveryPreparation {
    return this.transaction(() => {
      if (request.generationId !== this.context.generationId || request.resourceId !== request.claimId) {
        return { kind: "conflict" };
      }
      const claim = this.claimRow(request.claimId);
      if (claim === undefined || field(claim, "response_json") !== JSON.stringify(request.claim)
        || field(claim, "host_id") !== request.hostId || field(claim, "capacity") !== request.capacity) {
        return { kind: "conflict" };
      }
      const receipt = this.database.prepare(`SELECT state, recovery_request_id, assignment_json, issuance_json
        FROM native_root_ci_claim_receipts WHERE claim_id = ?`).get(request.claimId);
      if (receipt !== undefined && field(receipt, "state") === "released") {
        return field(receipt, "recovery_request_id") === request.requestId ? { kind: "released" } : { kind: "conflict" };
      }
      if (receipt !== undefined && (field(receipt, "assignment_json") !== JSON.stringify(assignment)
        || field(receipt, "issuance_json") !== JSON.stringify(request.issuance))) return { kind: "conflict" };
      if (receipt !== undefined && field(receipt, "state") === "recovering"
        && field(receipt, "recovery_request_id") !== request.requestId) return { kind: "conflict" };
      if (receipt !== undefined && field(receipt, "state") === "reported") {
        const outbox = this.database.prepare(`SELECT state FROM native_root_ci_report_outbox WHERE claim_id = ?`)
          .get(request.claimId);
        if (field(outbox, "state") !== "pending") return { kind: "conflict" };
      } else if (receipt !== undefined && field(receipt, "state") !== "active"
        && field(receipt, "state") !== "recovering") return { kind: "conflict" };
      const now = this.context.now();
      if (receipt === undefined) {
        this.database.prepare(`INSERT INTO native_root_ci_claim_receipts
          (claim_id, attempt_id, descriptor_digest, assignment_json, issuance_json, lease_expires_at,
            state, recovery_request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'recovering', ?, ?, ?)`).run(
          request.claimId, request.attemptId, request.descriptorDigest, JSON.stringify(assignment),
          JSON.stringify(request.issuance), now, request.requestId, now, now);
      } else {
        const update = this.database.prepare(`UPDATE native_root_ci_claim_receipts SET state = 'recovering',
          recovery_request_id = ?, updated_at = ? WHERE claim_id = ? AND state IN ('active','reported','recovering')`)
          .run(request.requestId, now, request.claimId);
        if (update.changes !== 1) throw new NativeRootCiClaimLifecycleStoreError();
      }
      if (this.database.prepare(`UPDATE native_root_ci_claims SET state = 'recovering', updated_at = ?
        WHERE claim_id = ? AND state IN ('preparing','active','reported','recovering')`)
        .run(now, request.claimId).changes !== 1) throw new NativeRootCiClaimLifecycleStoreError();
      return { kind: "pending", request };
    });
  }

  completeRecovery(request: NativeRootCiClaimRecoveryRequest, revocation: NativeJobAttemptRevocation): boolean {
    return this.transaction(() => {
      const parsed = parseNativeJobAttemptRevocation(revocation);
      const receipt = this.database.prepare(`SELECT state, recovery_request_id, issuance_json
        FROM native_root_ci_claim_receipts WHERE claim_id = ?`).get(request.claimId);
      if (receipt === undefined || field(receipt, "state") !== "recovering"
        || field(receipt, "recovery_request_id") !== request.requestId
        || field(receipt, "issuance_json") !== JSON.stringify(request.issuance)
        || parsed.attemptId !== request.attemptId || parsed.descriptorDigest !== request.descriptorDigest
        || parsed.hostId !== request.hostId || parsed.capacity !== request.capacity) return false;
      const now = this.context.now();
      const result = this.database.prepare("SELECT 1 FROM native_root_ci_host_results WHERE claim_id = ?")
        .get(request.claimId);
      const outbox = this.database.prepare("SELECT state FROM native_root_ci_report_outbox WHERE claim_id = ?")
        .get(request.claimId);
      const reportedResult = result !== undefined && field(outbox, "state") === "pending";
      const uncertainAttempt = result === undefined && outbox === undefined;
      if (!reportedResult && !uncertainAttempt) return false;
      if (this.database.prepare(`UPDATE native_root_ci_claim_receipts SET state = 'released', revocation_json = ?,
        updated_at = ?, released_at = ? WHERE claim_id = ? AND state = 'recovering'`)
        .run(JSON.stringify(parsed), now, now, request.claimId).changes !== 1) {
        throw new NativeRootCiClaimLifecycleStoreError();
      }
      if (this.database.prepare(`UPDATE native_root_ci_claims SET state = 'released', updated_at = ?
        WHERE claim_id = ? AND state = 'recovering'`).run(now, request.claimId).changes !== 1) {
        throw new NativeRootCiClaimLifecycleStoreError();
      }
      if (reportedResult) {
        if (this.database.prepare(`UPDATE native_root_ci_report_outbox SET state = 'denied'
          WHERE claim_id = ? AND state = 'pending'`).run(request.claimId).changes !== 1) return false;
        if (this.database.prepare(`UPDATE native_root_ci_demands SET state = 'completed', updated_at = ?, terminal_at = ?
          WHERE demand_id = ? AND state = 'reported'`).run(now, now, request.claim.demandId).changes !== 1) {
          throw new NativeRootCiClaimLifecycleStoreError();
        }
      } else {
        if (this.database.prepare(`UPDATE native_root_ci_demands SET state = 'superseded', updated_at = ?, terminal_at = ?
          WHERE demand_id = ? AND state IN ('preparing','active')`)
          .run(now, now, request.claim.demandId).changes !== 1) throw new NativeRootCiClaimLifecycleStoreError();
      }
      return true;
    });
  }

  private currentEpoch(): boolean {
    return this.database.prepare(`SELECT 1 FROM native_root_ci_service_epochs WHERE epoch_id = ?
      AND generation_id = ? AND active = 1`).get(this.context.serviceEpochId, this.context.generationId) !== undefined;
  }
  private currentReservation(claimId: string): boolean {
    return this.database.prepare(`SELECT 1 FROM native_root_ci_claims c
      JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
      JOIN native_root_ci_event_receipts e
        ON e.admission_generation = d.admission_generation AND e.event_id = d.event_id
      JOIN native_root_admissions a ON a.admission_generation = c.admission_generation
      WHERE c.claim_id = ? AND c.state = 'preparing' AND d.state = 'preparing'
        AND a.state = 'active' AND a.lease_expires_at > ?
        AND a.control_plane_generation_id = c.generation_id
        AND a.capacity_config_digest = c.capacity_config_digest
        AND a.root_sequence = e.root_sequence AND a.root_commit = e.root_commit
        AND a.root_tree = e.root_tree AND a.policy_digest = e.policy_digest`)
      .get(claimId, this.context.now()) !== undefined;
  }
  private claimRow(claimId: string): unknown {
    return this.database.prepare("SELECT * FROM native_root_ci_claims WHERE claim_id = ?").get(claimId);
  }
  private transaction<Result>(operation: () => Result): Result {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
