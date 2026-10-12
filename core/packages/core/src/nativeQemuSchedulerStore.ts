import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { NativeQemuAttempt } from "./nativeQemuAuthorityClient.js";
import type { NativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
import { openNativeQemuSchedulerDatabase } from "./nativeQemuSchedulerDatabase.js";
import { NativeQemuSchedulerStoreError, nullableText, number, optionalText, parseAttempt, parseCompletion,
  parseEvent, stringArray, text, type NativeQemuCompletion } from "./nativeQemuSchedulerRows.js";

export type { NativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
export { NativeQemuSchedulerStoreError } from "./nativeQemuSchedulerRows.js";
export type { NativeQemuCompletion } from "./nativeQemuSchedulerRows.js";
export type NativeQemuAdmission = { readonly projectId: string; readonly admissionGeneration: string;
  readonly leaseExpiresAt: number; readonly policyRevision: string; readonly requiredJobSetRevision: string;
  readonly requiredQemuJobs: readonly string[] };
export type NativeQemuClaim = { readonly claimId: string; readonly requestId: string; readonly hostId: string;
  readonly capacity: string; readonly admissionGeneration: string; readonly leaseExpiresAt: number;
  readonly event: NativeQemuReviewEvent };
type ReservationInput = { readonly requestId: string; readonly hostId: string; readonly capacity: string;
  readonly leaseMilliseconds: number };
export type NativeQemuFinalization = { readonly state: "active" | "completed"; readonly claim: NativeQemuClaim;
  readonly attempt: NativeQemuAttempt; readonly result: NativeQemuCompletion | undefined };

export class NativeQemuSchedulerStore {
  readonly #database: DatabaseSync;
  constructor(path: string, readonly now: () => number = Date.now) {
    this.#database = openNativeQemuSchedulerDatabase(path);
  }
  close(): void { this.#database.close(); }

  admit(input: NativeQemuAdmission): void {
    if (input.requiredQemuJobs.length === 0 || new Set(input.requiredQemuJobs).size !== input.requiredQemuJobs.length) {
      throw new NativeQemuSchedulerStoreError("native QEMU admission jobs are invalid");
    }
    this.#database.prepare(`INSERT INTO native_qemu_admissions
      (project_id, admission_generation, lease_expires_at, policy_revision, job_set_revision, jobs_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET admission_generation=excluded.admission_generation,
      lease_expires_at=excluded.lease_expires_at, policy_revision=excluded.policy_revision,
      job_set_revision=excluded.job_set_revision, jobs_json=excluded.jobs_json`).run(input.projectId,
      input.admissionGeneration, input.leaseExpiresAt, input.policyRevision, input.requiredJobSetRevision,
      JSON.stringify([...input.requiredQemuJobs].sort()));
  }

  admission(projectId: string): NativeQemuAdmission | undefined {
    const row = this.#database.prepare("SELECT * FROM native_qemu_admissions WHERE project_id=? AND lease_expires_at>?")
      .get(projectId, this.now());
    if (row === undefined) return undefined;
    return { projectId, admissionGeneration: text(row, "admission_generation"),
      leaseExpiresAt: number(row, "lease_expires_at"), policyRevision: text(row, "policy_revision"),
      requiredJobSetRevision: text(row, "job_set_revision"),
      requiredQemuJobs: stringArray(text(row, "jobs_json")) };
  }

  eventStatus(eventId: string): Readonly<Record<string, unknown>> | undefined {
    const row = this.#database.prepare(`SELECT e.event_json,e.state,c.claim_id,c.host_id,c.capacity,
      c.attempt_id,c.descriptor_digest,c.result_json FROM native_qemu_events e
      LEFT JOIN native_qemu_claims c ON c.event_id=e.event_id WHERE e.event_id=?`).get(eventId);
    if (row === undefined) return undefined;
    return { event: parseEvent(text(row, "event_json")), state: text(row, "state"),
      ...optionalText(row, "claim_id", "claimId"), ...optionalText(row, "host_id", "hostId"),
      ...optionalText(row, "capacity", "capacity"), ...optionalText(row, "attempt_id", "attemptId"),
      ...optionalText(row, "descriptor_digest", "descriptorDigest"),
      ...(nullableText(row, "result_json") === undefined ? {} : { result: JSON.parse(nullableText(row, "result_json") ?? "") }) };
  }

  enqueue(admissionGeneration: string, event: NativeQemuReviewEvent): "created" | "replay" {
    const admission = this.#database.prepare(`SELECT project_id, lease_expires_at, policy_revision, job_set_revision, jobs_json
      FROM native_qemu_admissions WHERE admission_generation = ?`).get(admissionGeneration);
    if (admission === undefined || text(admission, "project_id") !== event.projectId
      || number(admission, "lease_expires_at") <= this.now() || text(admission, "policy_revision") !== event.policyRevision
      || text(admission, "job_set_revision") !== event.requiredJobSetRevision
      || !stringArray(text(admission, "jobs_json")).includes(event.jobName) || event.executionKind !== "qemu") {
      throw new NativeQemuSchedulerStoreError("native QEMU event is not admitted");
    }
    const serialized = JSON.stringify(event);
    const existing = this.#database.prepare("SELECT event_json FROM native_qemu_events WHERE event_id = ?").get(event.eventId);
    if (existing !== undefined) {
      if (text(existing, "event_json") !== serialized) throw new NativeQemuSchedulerStoreError("native QEMU event conflicts");
      return "replay";
    }
    this.#database.prepare(`INSERT INTO native_qemu_events
      (event_id, admission_generation, event_json, state, created_at) VALUES (?, ?, ?, 'queued', ?)`)
      .run(event.eventId, admissionGeneration, serialized, this.now());
    return "created";
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
        JOIN native_qemu_admissions a ON a.admission_generation=e.admission_generation
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
