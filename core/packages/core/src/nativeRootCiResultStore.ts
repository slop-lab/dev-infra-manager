import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseNativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import { parseNativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import {
  nativeRootCiTerminalEventDigest,
  type NativeRootCiHostResultRequest
} from "./nativeRootCiResultProtocol.js";

type ResultStoreContext = {
  readonly generationId: string;
  readonly serviceEpochId: string;
  readonly capacityConfigDigest: string;
  readonly now: () => number;
};

export type NativeRootCiResultIntake = "accepted" | "conflict" | "not-found";

export class NativeRootCiResultStore {
  constructor(readonly database: DatabaseSync, readonly context: ResultStoreContext) {}

  accept(authenticatedHost: string, request: NativeRootCiHostResultRequest): NativeRootCiResultIntake {
    const requestJson = JSON.stringify(request);
    const eventJson = JSON.stringify(request.terminalEvent);
    const eventDigest = nativeRootCiTerminalEventDigest(request.terminalEvent);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`SELECT claim_id, host_id, request_id, request_json
        FROM native_root_ci_host_results WHERE claim_id = ? OR (host_id = ? AND request_id = ?)`)
        .get(request.claimId, authenticatedHost, request.requestId);
      if (existing !== undefined) {
        return this.finish(field(existing, "claim_id") === request.claimId
          && field(existing, "host_id") === authenticatedHost
          && field(existing, "request_id") === request.requestId
          && field(existing, "request_json") === requestJson ? "accepted" : "conflict");
      }
      const row = this.currentClaim(request.claimId, authenticatedHost);
      if (row === undefined) return this.finish("not-found");
      if (!this.matches(row, request)) return this.finish("conflict");
      const now = this.context.now();
      const demandId = field(row, "demand_id");
      if (demandId === undefined) throw new NativeRootCiResultStoreError();
      this.database.prepare(`INSERT INTO native_root_ci_host_results
        (claim_id, host_id, request_id, generation_id, attempt_id, descriptor_digest, request_json,
          terminal_event_json, terminal_event_digest, cleanup_resource_id, cleanup_complete, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
        request.claimId, authenticatedHost, request.requestId, request.generationId,
        request.terminalEvent.payload.attemptId, request.terminalEvent.payload.descriptorDigest,
        requestJson, eventJson, eventDigest, request.resourceId, now);
      this.database.prepare(`INSERT INTO native_root_ci_report_outbox
        (claim_id, terminal_event_json, terminal_event_digest, state, created_at)
        VALUES (?, ?, ?, 'pending', ?)`).run(request.claimId, eventJson, eventDigest, now);
      this.requireUpdate(`UPDATE native_root_ci_claims SET state = 'reported', updated_at = ?
        WHERE claim_id = ? AND state = 'active'`, now, request.claimId);
      this.requireUpdate(`UPDATE native_root_ci_claim_receipts SET state = 'reported', updated_at = ?
        WHERE claim_id = ? AND state = 'active'`, now, request.claimId);
      this.requireUpdate(`UPDATE native_root_ci_demands SET state = 'reported', updated_at = ?
        WHERE demand_id = ? AND state = 'active'`, now, demandId);
      return this.finish("accepted");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private currentClaim(claimId: string, hostId: string): unknown {
    return this.database.prepare(`SELECT c.*, r.state receipt_state, r.attempt_id, r.descriptor_digest,
      r.assignment_json, r.issuance_json, r.lease_expires_at, d.state demand_state,
      a.state admission_state, a.lease_expires_at admission_expires_at,
      a.control_plane_generation_id, a.capacity_config_digest admission_capacity_digest,
      e.root_sequence event_root_sequence, e.root_commit event_root_commit,
      e.root_tree event_root_tree, e.policy_digest event_policy_digest,
      a.root_sequence admission_root_sequence, a.root_commit admission_root_commit,
      a.root_tree admission_root_tree, a.policy_digest admission_policy_digest
      FROM native_root_ci_claims c
      JOIN native_root_ci_claim_receipts r ON r.claim_id = c.claim_id
      JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
      JOIN native_root_ci_event_receipts e
        ON e.admission_generation = d.admission_generation AND e.event_id = d.event_id
      JOIN native_root_admissions a ON a.admission_generation = c.admission_generation
      WHERE c.claim_id = ? AND c.host_id = ?`).get(claimId, hostId);
  }

  private matches(row: unknown, request: NativeRootCiHostResultRequest): boolean {
    const event = request.terminalEvent.payload;
    const now = this.context.now();
    if (request.generationId !== this.context.generationId
      || field(row, "generation_id") !== this.context.generationId
      || field(row, "service_epoch_id") !== this.context.serviceEpochId
      || field(row, "capacity_config_digest") !== this.context.capacityConfigDigest
      || field(row, "admission_capacity_digest") !== this.context.capacityConfigDigest
      || field(row, "control_plane_generation_id") !== this.context.generationId
      || field(row, "state") !== "active" || field(row, "receipt_state") !== "active"
      || field(row, "demand_state") !== "active" || field(row, "admission_state") !== "active"
      || numeric(row, "lease_expires_at") <= now || numeric(row, "admission_expires_at") <= now
      || !this.currentEpoch()
      || field(row, "event_root_commit") !== field(row, "admission_root_commit")
      || field(row, "event_root_tree") !== field(row, "admission_root_tree")
      || field(row, "event_policy_digest") !== field(row, "admission_policy_digest")
      || numeric(row, "event_root_sequence") !== numeric(row, "admission_root_sequence")) return false;
    const assignmentJson = field(row, "assignment_json");
    const issuanceJson = field(row, "issuance_json");
    if (assignmentJson === undefined || issuanceJson === undefined) return false;
    const assignment = parseNativeAttemptAssignment(JSON.parse(assignmentJson));
    const issuance = parseNativeJobAttemptIssuance(JSON.parse(issuanceJson));
    return event.reviewId === assignment.reviewId && event.reviewId === issuance.reviewId
      && event.attemptId === assignment.attemptId && event.attemptId === issuance.attemptId
      && event.attempt === issuance.attempt
      && event.descriptorDigest === assignment.descriptorDigest
      && event.descriptorDigest === issuance.descriptorDigest
      && event.hostId === assignment.hostId && event.hostId === issuance.hostId
      && event.capacity === assignment.capacity && event.capacity === issuance.capacity
      && isDeepStrictEqual(event.descriptor, assignment.descriptor)
      && isDeepStrictEqual(event.descriptor, issuance.descriptor);
  }

  private currentEpoch(): boolean {
    return this.database.prepare(`SELECT 1 FROM native_root_ci_service_epochs
      WHERE epoch_id = ? AND generation_id = ? AND active = 1`).get(
      this.context.serviceEpochId, this.context.generationId) !== undefined;
  }

  private finish(result: NativeRootCiResultIntake): NativeRootCiResultIntake {
    this.database.exec("COMMIT");
    return result;
  }

  private requireUpdate(sql: string, ...parameters: readonly (number | string)[]): void {
    if (this.database.prepare(sql).run(...parameters).changes !== 1) throw new NativeRootCiResultStoreError();
  }
}

class NativeRootCiResultStoreError extends Error {
  readonly name = "NativeRootCiResultStoreError";
  constructor() { super("native root CI result state changed during commit"); }
}

function field(row: unknown, name: string): string | undefined {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  return typeof value === "string" ? value : undefined;
}

function numeric(row: unknown, name: string): number {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  return typeof value === "number" ? value : 0;
}
