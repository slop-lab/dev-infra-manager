import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { NativeQemuAttempt } from "./nativeQemuAuthorityClient.js";
import type { NativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
import { openNativeQemuSchedulerDatabase } from "./nativeQemuSchedulerDatabase.js";
import { NativeQemuSchedulerStoreError, nullableText, number, optionalText, parseAttempt, parseCompletion,
  parseEvent, text, type NativeQemuCompletion } from "./nativeQemuSchedulerRows.js";

export type { NativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
export { NativeQemuSchedulerStoreError } from "./nativeQemuSchedulerRows.js";
export type { NativeQemuCompletion } from "./nativeQemuSchedulerRows.js";
export type NativeQemuClaim = { readonly claimId: string; readonly requestId: string; readonly hostId: string;
  readonly capacity: string; readonly admissionGeneration: string; readonly leaseExpiresAt: number;
  readonly event: NativeQemuReviewEvent };
type ReservationInput = { readonly requestId: string; readonly hostId: string; readonly capacity: string;
  readonly leaseMilliseconds: number };
export type NativeQemuFinalization = { readonly state: "active" | "completed"; readonly claim: NativeQemuClaim;
  readonly attempt: NativeQemuAttempt; readonly result: NativeQemuCompletion | undefined };

export class NativeQemuSchedulerStore {
  readonly #database: DatabaseSync;
  constructor(path: string, executionAuthorityJson: string, readonly now: () => number = Date.now) {
    this.#database = openNativeQemuSchedulerDatabase(path, executionAuthorityJson);
  }
  close(): void { this.#database.close(); }

  serviceGenerationId(): string {
    const row = this.#database.prepare("SELECT value FROM native_qemu_metadata WHERE key='service_generation_id'").get();
    return text(row, "value");
  }

  eventStatus(eventId: string): Readonly<Record<string, unknown>> | undefined {
    const row = this.#database.prepare(`SELECT e.event_json,e.state,c.claim_id,c.host_id,c.capacity,
      c.attempt_id,c.descriptor_digest,c.result_json,e.admission_generation,a.lease_expires_at
      FROM native_qemu_events e
      LEFT JOIN native_qemu_claims c ON c.event_id=e.event_id
      LEFT JOIN native_qemu_eligibility a ON a.eligibility_generation=e.admission_generation
      WHERE e.event_id=?`).get(eventId);
    if (row === undefined) return undefined;
    return { event: parseEvent(text(row, "event_json")), state: text(row, "state"),
      ...optionalText(row, "claim_id", "claimId"), ...optionalText(row, "host_id", "hostId"),
      ...optionalText(row, "capacity", "capacity"), ...optionalText(row, "attempt_id", "attemptId"),
      ...optionalText(row, "descriptor_digest", "descriptorDigest"),
      eligibilityGeneration: text(row, "admission_generation"),
      eligibilityExpiresAt: number(row, "lease_expires_at"),
      ...(nullableText(row, "result_json") === undefined ? {} : { result: JSON.parse(nullableText(row, "result_json") ?? "") }) };
  }

  enqueue(event: NativeQemuReviewEvent, eligibilityLeaseMilliseconds: number): {
    readonly result: "created" | "replay"; readonly eligibilityGeneration: string; readonly expiresAt: number
  } {
    if (event.executionKind !== "qemu") throw new NativeQemuSchedulerStoreError("native QEMU event is invalid");
    return this.transaction(() => {
      const now = this.now();
      const expiresAt = now + eligibilityLeaseMilliseconds;
      const existingEligibility = this.#database.prepare("SELECT * FROM native_qemu_eligibility WHERE project_id=?")
        .get(event.projectId);
      const eligibilityGeneration = existingEligibility === undefined
        ? randomUUID() : text(existingEligibility, "eligibility_generation");
      this.#database.prepare(`INSERT INTO native_qemu_eligibility
        (project_id,eligibility_generation,lease_expires_at,refreshed_at) VALUES (?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET eligibility_generation=excluded.eligibility_generation,
        lease_expires_at=excluded.lease_expires_at,refreshed_at=excluded.refreshed_at`)
        .run(event.projectId, eligibilityGeneration, expiresAt, now);
      this.#database.prepare(`UPDATE native_qemu_events SET admission_generation=?
        WHERE state='queued' AND json_extract(event_json,'$.projectId')=?`)
        .run(eligibilityGeneration, event.projectId);
      const serialized = JSON.stringify(event);
      const existing = this.#database.prepare("SELECT event_json FROM native_qemu_events WHERE event_id = ?").get(event.eventId);
      if (existing !== undefined) {
        if (text(existing, "event_json") !== serialized) throw new NativeQemuSchedulerStoreError("native QEMU event conflicts");
        return { result: "replay", eligibilityGeneration, expiresAt };
      }
      this.#database.prepare(`INSERT INTO native_qemu_events
        (event_id, admission_generation, event_json, state, created_at) VALUES (?, ?, ?, 'queued', ?)`)
        .run(event.eventId, eligibilityGeneration, serialized, now);
      return { result: "created", eligibilityGeneration, expiresAt };
    });
  }

  reserve(input: ReservationInput): NativeQemuClaim | undefined {
    return this.transaction(() => {
      this.expireClaims();
      const replay = this.#database.prepare("SELECT * FROM native_qemu_claims WHERE request_id = ?").get(input.requestId);
      if (replay !== undefined) {
        if (text(replay, "host_id") !== input.hostId || text(replay, "capacity") !== input.capacity) {
          throw new NativeQemuSchedulerStoreError("native QEMU claim request conflicts");
        }
        return text(replay, "state") === "completed" ? undefined : this.claim(replay);
      }
      if (this.#database.prepare(`SELECT 1 FROM native_qemu_claims WHERE host_id=? AND capacity=?
        AND state IN ('reserved','active')`).get(input.hostId, input.capacity) !== undefined) return undefined;
      const row = this.#database.prepare(`SELECT e.event_id, e.admission_generation, e.event_json FROM native_qemu_events e
        JOIN native_qemu_eligibility a ON a.eligibility_generation=e.admission_generation
        WHERE e.state='queued' AND a.lease_expires_at>? ORDER BY e.created_at,e.event_id LIMIT 1`).get(this.now());
      if (row === undefined) return undefined;
      const claimId = randomUUID();
      const leaseExpiresAt = this.now() + input.leaseMilliseconds;
      this.#database.prepare(`INSERT INTO native_qemu_claims
        (claim_id,request_id,event_id,host_id,capacity,admission_generation,lease_expires_at,state)
        VALUES (?,?,?,?,?,?,?,'reserved')`).run(claimId, input.requestId, text(row, "event_id"), input.hostId,
        input.capacity, text(row, "admission_generation"), leaseExpiresAt);
      this.#database.prepare("UPDATE native_qemu_events SET state='reserved' WHERE event_id=?")
        .run(text(row, "event_id"));
      return { claimId, requestId: input.requestId, hostId: input.hostId, capacity: input.capacity,
        admissionGeneration: text(row, "admission_generation"), leaseExpiresAt,
        event: parseEvent(text(row, "event_json")) };
    });
  }

  activate(claimId: string, attempt: NativeQemuAttempt): void {
    const result = this.#database.prepare(`UPDATE native_qemu_claims
      SET state='active',attempt_id=?,descriptor_digest=?,attempt_json=?
      WHERE claim_id=? AND state='reserved' AND lease_expires_at>?`).run(attempt.attemptId, attempt.descriptorDigest,
      JSON.stringify(attempt), claimId, this.now());
    if (result.changes !== 1) throw new NativeQemuSchedulerStoreError("native QEMU claim activation conflicts");
    this.#database.prepare("UPDATE native_qemu_events SET state='active' WHERE event_id=(SELECT event_id FROM native_qemu_claims WHERE claim_id=?)")
      .run(claimId);
  }

  assignment(requestId: string, hostId: string, capacity: string):
    { readonly claim: NativeQemuClaim; readonly attempt: NativeQemuAttempt } | undefined {
    const row = this.#database.prepare("SELECT * FROM native_qemu_claims WHERE request_id=?").get(requestId);
    if (row === undefined) return undefined;
    if (text(row, "host_id") !== hostId || text(row, "capacity") !== capacity) {
      throw new NativeQemuSchedulerStoreError("native QEMU claim request conflicts");
    }
    if (text(row, "state") !== "active") return undefined;
    return { claim: this.claim(row), attempt: parseAttempt(text(row, "attempt_json")) };
  }

  renew(claimId: string, hostId: string, capacity: string, leaseMilliseconds: number): number {
    const leaseExpiresAt = this.now() + leaseMilliseconds;
    const result = this.#database.prepare(`UPDATE native_qemu_claims SET lease_expires_at=? WHERE claim_id=?
      AND host_id=? AND capacity=? AND state='active' AND lease_expires_at>?`)
      .run(leaseExpiresAt, claimId, hostId, capacity, this.now());
    if (result.changes !== 1) throw new NativeQemuSchedulerStoreError("native QEMU claim renewal conflicts");
    return leaseExpiresAt;
  }

  current(claimId: string): (NativeQemuClaim & { readonly attemptId: string; readonly descriptorDigest: string }) | undefined {
    const row = this.#database.prepare(`SELECT * FROM native_qemu_claims
      WHERE claim_id=? AND state='active' AND lease_expires_at>?`).get(claimId, this.now());
    if (row === undefined) return undefined;
    return { ...this.claim(row), attemptId: text(row, "attempt_id"), descriptorDigest: text(row, "descriptor_digest") };
  }

  finalization(claimId: string, hostId: string, capacity: string): NativeQemuFinalization | undefined {
    const row = this.#database.prepare(`SELECT * FROM native_qemu_claims
      WHERE claim_id=? AND host_id=? AND capacity=? AND state IN ('active','completed')`).get(claimId, hostId, capacity);
    if (row === undefined || nullableText(row, "attempt_json") === undefined) return undefined;
    const state = text(row, "state");
    if (state !== "active" && state !== "completed") throw new NativeQemuSchedulerStoreError("native QEMU state is invalid");
    const resultJson = nullableText(row, "result_json");
    return { state, claim: this.claim(row), attempt: parseAttempt(text(row, "attempt_json")),
      result: resultJson === undefined ? undefined : parseCompletion(resultJson) };
  }

  complete(input: NativeQemuCompletion): "created" | "replay" {
    const result = this.recordResult(input);
    this.acknowledgeResult(input.claimId);
    return result;
  }

  recordResult(input: NativeQemuCompletion): "created" | "replay" {
    if (!input.cleanupComplete) throw new NativeQemuSchedulerStoreError("native QEMU result requires complete cleanup");
    return this.transaction(() => {
      const row = this.#database.prepare("SELECT state,result_json,event_id FROM native_qemu_claims WHERE claim_id=?")
        .get(input.claimId);
      if (row === undefined) throw new NativeQemuSchedulerStoreError("native QEMU claim was not found");
      const serialized = JSON.stringify(input);
      if (text(row, "state") === "completed") {
        if (text(row, "result_json") !== serialized) throw new NativeQemuSchedulerStoreError("native QEMU result conflicts");
        return "replay";
      }
      if (text(row, "state") !== "active") throw new NativeQemuSchedulerStoreError("native QEMU claim is not active");
      const existing = nullableText(row, "result_json");
      if (existing !== undefined) {
        if (existing !== serialized) throw new NativeQemuSchedulerStoreError("native QEMU result conflicts");
        return "replay";
      }
      this.#database.prepare("UPDATE native_qemu_claims SET result_json=? WHERE claim_id=?").run(serialized, input.claimId);
      this.#database.prepare(`INSERT INTO native_qemu_report_outbox
        (claim_id,terminal_event_json,state,created_at,delivered_at) VALUES (?,?,'pending',?,NULL)`)
        .run(input.claimId, JSON.stringify(input.terminalEvent), this.now());
      return "created";
    });
  }

  acknowledgeResult(claimId: string): void {
    this.transaction(() => {
      const row = this.#database.prepare("SELECT state,result_json,event_id FROM native_qemu_claims WHERE claim_id=?")
        .get(claimId);
      if (row === undefined || nullableText(row, "result_json") === undefined) {
        throw new NativeQemuSchedulerStoreError("native QEMU result was not recorded");
      }
      if (text(row, "state") === "completed") return;
      if (text(row, "state") !== "active") throw new NativeQemuSchedulerStoreError("native QEMU claim is not active");
      this.#database.prepare("UPDATE native_qemu_claims SET state='completed' WHERE claim_id=?").run(claimId);
      this.#database.prepare("UPDATE native_qemu_events SET state='completed' WHERE event_id=?").run(text(row, "event_id"));
      this.#database.prepare("UPDATE native_qemu_report_outbox SET state='delivered',delivered_at=? WHERE claim_id=?")
        .run(this.now(), claimId);
    });
  }

  pendingReports(): readonly { readonly claim: NativeQemuClaim;
    readonly terminalEvent: import("./nativeQemuTerminalEvent.js").NativeQemuTerminalEvent }[] {
    return this.#database.prepare(`SELECT c.* FROM native_qemu_report_outbox o
      JOIN native_qemu_claims c ON c.claim_id=o.claim_id WHERE o.state='pending' ORDER BY o.created_at,o.claim_id`)
      .all().map((row) => {
        const outbox = this.#database.prepare("SELECT terminal_event_json FROM native_qemu_report_outbox WHERE claim_id=?")
          .get(text(row, "claim_id"));
        if (outbox === undefined) throw new NativeQemuSchedulerStoreError("native QEMU report outbox is invalid");
        return { claim: this.claim(row), terminalEvent: JSON.parse(text(outbox, "terminal_event_json")) as
          import("./nativeQemuTerminalEvent.js").NativeQemuTerminalEvent };
      });
  }

  recover(claimId: string, hostId: string, capacity: string): void {
    this.transaction(() => {
      const row = this.#database.prepare(`SELECT event_id,state FROM native_qemu_claims
        WHERE claim_id=? AND host_id=? AND capacity=?`).get(claimId, hostId, capacity);
      if (row === undefined) throw new NativeQemuSchedulerStoreError("native QEMU recovery claim was not found");
      if (text(row, "state") === "completed") return;
      this.#database.prepare("UPDATE native_qemu_claims SET state='completed' WHERE claim_id=?").run(claimId);
      this.#database.prepare("UPDATE native_qemu_events SET state='completed' WHERE event_id=?").run(text(row, "event_id"));
    });
  }

  supersedeReservation(claimId: string): void {
    this.transaction(() => {
      const row = this.#database.prepare("SELECT event_id,state FROM native_qemu_claims WHERE claim_id=?").get(claimId);
      if (row === undefined || text(row, "state") !== "reserved") {
        throw new NativeQemuSchedulerStoreError("native QEMU reservation supersession conflicts");
      }
      this.#database.prepare("UPDATE native_qemu_events SET state='superseded' WHERE event_id=?")
        .run(text(row, "event_id"));
      this.#database.prepare("DELETE FROM native_qemu_claims WHERE claim_id=?").run(claimId);
    });
  }

  private claim(row: unknown): NativeQemuClaim {
    const eventRow = this.#database.prepare("SELECT event_json FROM native_qemu_events WHERE event_id=?")
      .get(text(row, "event_id"));
    if (eventRow === undefined) throw new NativeQemuSchedulerStoreError("native QEMU claim event is missing");
    return { claimId: text(row, "claim_id"), requestId: text(row, "request_id"), hostId: text(row, "host_id"),
      capacity: text(row, "capacity"), admissionGeneration: text(row, "admission_generation"),
      leaseExpiresAt: number(row, "lease_expires_at"), event: parseEvent(text(eventRow, "event_json")) };
  }
  private expireClaims(): void {
    this.#database.prepare(`UPDATE native_qemu_events SET state='queued' WHERE event_id IN
      (SELECT event_id FROM native_qemu_claims WHERE state='reserved' AND lease_expires_at<=?)`)
      .run(this.now());
    this.#database.prepare(`DELETE FROM native_qemu_claims
      WHERE state='reserved' AND lease_expires_at<=?`).run(this.now());
  }
  private transaction<Result>(operation: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.#database.exec("COMMIT"); return result; }
    catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
}
