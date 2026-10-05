import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { parseNativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import type { NativeAttemptVerification } from "./nativeOrdinaryAuthorityModel.js";
import { requiredClaimNumber, requiredClaimString, stringField } from "./nativeOrdinaryAuthorityRows.js";
import {
  parseNativeTerminalEvent,
  terminalEventDigest,
  terminalEventJson,
  type NativeHostResultRequest,
  type NativeTerminalEvent
} from "./nativeOrdinaryResultProtocol.js";

type ResultStoreOptions = {
  readonly serviceId: string;
  readonly capacityConfigDigest: string;
  readonly now: () => number;
};

export type NativeHostResultIntake = "accepted" | "conflict" | "not-found";

export type NativeReportDelivery = {
  readonly claimId: string;
  readonly terminalEventJson: string;
  readonly attemptCount: number;
};

type ResultCompletion = {
  readonly claimId: string;
  readonly outcome: "delivered" | "denied";
  readonly denialCode: string | undefined;
  readonly now: number;
};

export class NativeOrdinaryResultStore {
  readonly #database: DatabaseSync;
  readonly #options: ResultStoreOptions;

  constructor(database: DatabaseSync, options: ResultStoreOptions) {
    this.#database = database;
    this.#options = options;
  }

  accept(authenticatedHost: string, request: NativeHostResultRequest): NativeHostResultIntake {
    const now = this.#options.now();
    const eventJson = terminalEventJson(request.terminalEvent);
    const eventDigest = terminalEventDigest(eventJson);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(`
        SELECT claim_id, host_id, request_id, terminal_event_digest FROM host_results
        WHERE claim_id = ? OR (host_id = ? AND request_id = ?)
      `).get(request.claimId, authenticatedHost, request.requestId);
      if (existing !== undefined) {
        const exact = stringField(existing, "claim_id") === request.claimId
          && stringField(existing, "host_id") === authenticatedHost
          && stringField(existing, "request_id") === request.requestId
          && stringField(existing, "terminal_event_digest") === eventDigest;
        return this.#finish(exact ? "accepted" : "conflict");
      }
      const row = this.#database.prepare(`
        SELECT claims.*, receipts.state receipt_state, demands.state demand_state,
          admissions.state admission_state, admissions.expires_at admission_expires_at,
          admissions.capacity_config_digest, attempts.claim_id assignment_claim_id
        FROM claims
        JOIN claim_receipts receipts ON receipts.claim_id = claims.claim_id
        JOIN demands ON demands.demand_id = claims.demand_id
        JOIN native_admissions admissions ON admissions.admission_generation = claims.admission_generation
        LEFT JOIN native_attempt_assignments attempts ON attempts.claim_id = claims.claim_id
        WHERE claims.claim_id = ? AND claims.host_id = ?
      `).get(request.claimId, authenticatedHost);
      if (row === undefined) return this.#finish("not-found");
      if (!this.#currentClaim(row, request.terminalEvent, now)) return this.#finish("conflict");
      this.#database.prepare(`
        INSERT INTO host_results(
          claim_id, host_id, request_id, attempt_id, descriptor_digest,
          terminal_event_json, terminal_event_digest, cleanup_complete, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(request.claimId, authenticatedHost, request.requestId, request.terminalEvent.payload.attemptId,
        request.terminalEvent.payload.descriptorDigest, eventJson, eventDigest, now);
      this.#database.prepare(`
        INSERT INTO report_outbox(
          claim_id, terminal_event_json, terminal_event_digest, state,
          attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(request.claimId, eventJson, eventDigest, now, now, now);
      this.#database.prepare("UPDATE claims SET state = 'reported' WHERE claim_id = ?").run(request.claimId);
      this.#database.prepare("UPDATE claim_receipts SET state = 'reported', updated_at = ? WHERE claim_id = ?")
        .run(now, request.claimId);
      this.#database.prepare(`
        UPDATE demands SET state = 'reported', updated_at = ?
        WHERE demand_id = (SELECT demand_id FROM claims WHERE claim_id = ?)
      `).run(now, request.claimId);
      return this.#finish("accepted");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  currentResult(input: NativeAttemptVerification): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM host_results results
      JOIN claims ON claims.claim_id = results.claim_id
      JOIN native_admissions admissions ON admissions.admission_generation = claims.admission_generation
      JOIN report_outbox outbox ON outbox.claim_id = claims.claim_id
      WHERE claims.review_id = ? AND results.attempt_id = ? AND results.descriptor_digest = ?
        AND claims.admission_generation = ? AND results.host_id = ? AND claims.capacity = ?
        AND results.cleanup_complete = 1 AND outbox.state <> 'denied'
        AND admissions.service_id = ? AND admissions.capacity_config_digest = ?
        AND admissions.state = 'active' AND admissions.expires_at > ?
    `).get(input.reviewId, input.attemptId, input.descriptorDigest, input.admissionGeneration,
      input.hostId, input.capacity, this.#options.serviceId, this.#options.capacityConfigDigest,
      this.#options.now()) !== undefined;
  }

  takeDue(): NativeReportDelivery | undefined {
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`
        SELECT outbox.claim_id, outbox.terminal_event_json, outbox.attempt_count,
          admissions.state admission_state, admissions.expires_at admission_expires_at,
          admissions.service_id, admissions.capacity_config_digest
        FROM report_outbox outbox
        JOIN claims ON claims.claim_id = outbox.claim_id
        JOIN native_admissions admissions ON admissions.admission_generation = claims.admission_generation
        WHERE outbox.state IN ('pending','delivering') AND outbox.next_attempt_at <= ?
        ORDER BY outbox.next_attempt_at, outbox.claim_id LIMIT 1
      `).get(now);
      if (row === undefined) return this.#finish(undefined);
      const claimId = requiredClaimString(row, "claim_id");
      if (stringField(row, "admission_state") !== "active"
        || requiredClaimNumber(row, "admission_expires_at") <= now
        || stringField(row, "service_id") !== this.#options.serviceId
        || stringField(row, "capacity_config_digest") !== this.#options.capacityConfigDigest) {
        this.#completeInTransaction({ claimId, outcome: "denied", denialCode: "admission-inactive", now });
        return this.#finish(undefined);
      }
      const attemptCount = requiredClaimNumber(row, "attempt_count") + 1;
      this.#database.prepare(`
        UPDATE report_outbox SET state = 'delivering', attempt_count = ?, updated_at = ? WHERE claim_id = ?
      `).run(attemptCount, now, claimId);
      return this.#finish({
        claimId,
        terminalEventJson: requiredClaimString(row, "terminal_event_json"),
        attemptCount
      });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  retry(delivery: NativeReportDelivery): void {
    const now = this.#options.now();
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(delivery.attemptCount - 1, 5)));
    this.#database.prepare(`
      UPDATE report_outbox SET state = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE claim_id = ? AND state = 'delivering'
    `).run(now + delay, now, delivery.claimId);
  }

  complete(claimId: string, outcome: "delivered" | "denied", denialCode?: string): void {
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.#completeInTransaction({ claimId, outcome, denialCode, now })) {
        this.#database.exec("ROLLBACK");
        return;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  parseDelivery(delivery: NativeReportDelivery): NativeTerminalEvent {
    return parseNativeTerminalEvent(JSON.parse(delivery.terminalEventJson));
  }

  denyGeneration(generation: string, now: number): void {
    const rows = this.#database.prepare(`
      SELECT claim_id FROM claims WHERE admission_generation = ? AND state = 'reported'
    `).all(generation);
    for (const row of rows) {
      this.#completeInTransaction({
        claimId: requiredClaimString(row, "claim_id"),
        outcome: "denied",
        denialCode: "admission-inactive",
        now
      });
    }
  }

  #currentClaim(row: unknown, event: NativeTerminalEvent, now: number): boolean {
    const issuance = parseNativeJobAttemptIssuance(JSON.parse(requiredClaimString(row, "issuance_json")));
    return stringField(row, "state") === "active"
      && stringField(row, "receipt_state") === "active"
      && stringField(row, "demand_state") === "claimed"
      && stringField(row, "admission_state") === "active"
      && requiredClaimNumber(row, "lease_expires_at") > now
      && requiredClaimNumber(row, "admission_expires_at") > now
      && stringField(row, "capacity_config_digest") === this.#options.capacityConfigDigest
      && stringField(row, "assignment_claim_id") === requiredClaimString(row, "claim_id")
      && event.payload.reviewId === requiredClaimString(row, "review_id")
      && event.payload.attemptId === requiredClaimString(row, "attempt_id")
      && event.payload.attempt === issuance.attempt
      && event.payload.descriptorDigest === requiredClaimString(row, "descriptor_digest")
      && event.payload.hostId === requiredClaimString(row, "host_id")
      && event.payload.capacity === requiredClaimString(row, "capacity")
      && event.payload.descriptor.admissionGeneration === requiredClaimString(row, "admission_generation")
      && isDeepStrictEqual(event.payload.descriptor, JSON.parse(requiredClaimString(row, "descriptor_json")));
  }

  #completeInTransaction(input: ResultCompletion): boolean {
    const row = this.#database.prepare(`
      SELECT claims.demand_id, claims.state, results.cleanup_complete
      FROM claims JOIN host_results results ON results.claim_id = claims.claim_id
      JOIN report_outbox outbox ON outbox.claim_id = claims.claim_id
      WHERE claims.claim_id = ? AND outbox.state IN ('pending','delivering')
    `).get(input.claimId);
    if (row === undefined || stringField(row, "state") !== "reported"
      || requiredClaimNumber(row, "cleanup_complete") !== 1) return false;
    const demandId = requiredClaimString(row, "demand_id");
    this.#database.prepare(`
      UPDATE report_outbox SET state = ?, denial_code = ?, updated_at = ? WHERE claim_id = ?
    `).run(input.outcome, input.denialCode ?? null, input.now, input.claimId);
    this.#database.prepare("UPDATE claims SET state = 'released', released_at = ? WHERE claim_id = ?")
      .run(input.now, input.claimId);
    this.#database.prepare(`
      UPDATE claim_receipts SET state = 'released', updated_at = ?, released_at = ? WHERE claim_id = ?
    `).run(input.now, input.now, input.claimId);
    this.#database.prepare(`
      UPDATE demands SET state = ?, updated_at = ?, terminal_at = ? WHERE demand_id = ?
    `).run(input.outcome === "delivered" ? "completed" : "failed", input.now, input.now, demandId);
    this.#database.prepare(`
      UPDATE native_event_inbox SET state = 'terminal', terminal_at = ?
      WHERE event_id = (SELECT event_id FROM demands WHERE demand_id = ?)
    `).run(input.now, demandId);
    this.#database.prepare("DELETE FROM native_attempt_assignments WHERE claim_id = ?").run(input.claimId);
    this.#database.prepare("DELETE FROM capacity_fences WHERE claim_id = ?").run(input.claimId);
    return true;
  }

  #finish<T>(value: T): T {
    this.#database.exec("COMMIT");
    return value;
  }
}
