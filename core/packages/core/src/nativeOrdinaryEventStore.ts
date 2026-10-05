import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import { parseNativeAdmissionPolicy } from "./nativeOrdinaryAuthorityModel.js";
import {
  canonicalNativeEvent,
  nativeEventDigest,
  nativeReviewJobTupleDigest,
  type NativeReviewJobEvent
} from "./nativeOrdinaryEvent.js";

const replayFenceLimit = 100_000;
const nonterminalDemandLimit = 10_000;

export type NativeEventIntakeResult = "accepted" | "conflict" | "full" | "new" | "not_found";

type EventStoreOptions = {
  readonly serviceId: string;
  readonly capacityConfigDigest: string;
  readonly now: () => number;
};

type AcceptedEvent = {
  readonly event: NativeReviewJobEvent;
  readonly eventDigest: string;
  readonly tupleDigest: string;
  readonly admissionGeneration: string;
  readonly now: number;
};

export class NativeOrdinaryEventStore {
  readonly #database: DatabaseSync;
  readonly #options: EventStoreOptions;

  constructor(database: DatabaseSync, options: EventStoreOptions) {
    this.#database = database;
    this.#options = options;
  }

  checkReplay(event: NativeReviewJobEvent): NativeEventIntakeResult {
    const eventDigest = nativeEventDigest(event);
    const tupleDigest = nativeReviewJobTupleDigest(event);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const eventFence = stringField(this.#database.prepare(`
        SELECT event_digest FROM native_event_replay_fences WHERE event_id = ?
      `).get(event.eventId), "event_digest");
      if (eventFence !== undefined) {
        if (eventFence === eventDigest) return this.finish("accepted");
        this.#database.exec("ROLLBACK");
        return "new";
      }
      const tupleFence = stringField(this.#database.prepare(`
        SELECT tuple_digest FROM review_job_replay_fences WHERE review_id = ? AND job_name = ?
      `).get(event.reviewId, event.jobName), "tuple_digest");
      if (tupleFence !== undefined) {
        if (tupleFence !== tupleDigest) {
          this.#database.exec("ROLLBACK");
          return "new";
        }
        if (this.fenceCount("native_event_replay_fences") >= replayFenceLimit) return this.finish("full");
        this.#database.prepare("INSERT INTO native_event_replay_fences(event_id, event_digest) VALUES (?, ?)")
          .run(event.eventId, eventDigest);
        return this.finish("accepted");
      }
      this.#database.exec("ROLLBACK");
      return "new";
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  accept(event: NativeReviewJobEvent): NativeEventIntakeResult {
    const eventDigest = nativeEventDigest(event);
    const tupleDigest = nativeReviewJobTupleDigest(event);
    const now = this.#options.now();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.replayInTransaction(event, eventDigest, tupleDigest);
      if (replay !== "new") return this.finish(replay);
      const admission = activeAdmission(this.#database.prepare(`
        SELECT admission_generation, policy_json, expires_at FROM native_admissions
        WHERE project_id = ? AND repository_id = ? AND service_id = ? AND protected_ref = ?
          AND policy_revision = ? AND required_review_revision = ? AND required_job_set_revision = ?
          AND capacity_config_digest = ? AND state = 'active'
      `).get(
        event.projectId, event.repositoryId, this.#options.serviceId, event.protectedRef, event.policyRevision,
        event.requiredReviewRevision, event.requiredJobSetRevision, this.#options.capacityConfigDigest
      ));
      if (admission === undefined || admission.expiresAt <= now || !admission.policy.requiredJobs.includes(event.jobName)) {
        return this.finish("not_found");
      }
      if (this.fenceCount("native_event_replay_fences") >= replayFenceLimit
        || this.fenceCount("review_job_replay_fences") >= replayFenceLimit
        || this.nonterminalDemandCount() >= nonterminalDemandLimit) return this.finish("full");
      this.insertAccepted({ event, eventDigest, tupleDigest, admissionGeneration: admission.generation, now });
      return this.finish("accepted");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertAccepted(input: AcceptedEvent): void {
    const { event, eventDigest, tupleDigest, admissionGeneration, now } = input;
    const demandId = randomUUID();
    this.#database.prepare("INSERT INTO native_event_replay_fences(event_id, event_digest) VALUES (?, ?)")
      .run(event.eventId, eventDigest);
    this.#database.prepare("INSERT INTO review_job_replay_fences(review_id, job_name, tuple_digest) VALUES (?, ?, ?)")
      .run(event.reviewId, event.jobName, tupleDigest);
    this.#database.prepare(`
      INSERT INTO native_event_inbox(
        event_id, event_digest, event_json, project_id, repository_id, protected_ref, review_id,
        expected_protected_head, candidate_commit, candidate_tree, policy_revision, required_review_revision,
        required_job_set_revision, job_name, evidence_class, demand_id, state, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)
    `).run(
      event.eventId, eventDigest, canonicalNativeEvent(event), event.projectId, event.repositoryId,
      event.protectedRef, event.reviewId, event.expectedProtectedHead, event.candidateCommit, event.candidateTree,
      event.policyRevision, event.requiredReviewRevision, event.requiredJobSetRevision, event.jobName,
      event.evidenceClass, null, now
    );
    this.#database.prepare(`
      INSERT INTO demands(
        demand_id, event_id, project_id, repository_id, protected_ref, review_id, expected_protected_head,
        candidate_commit, candidate_tree, policy_revision, required_review_revision, required_job_set_revision,
        job_name, evidence_class, admission_generation, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      demandId, event.eventId, event.projectId, event.repositoryId, event.protectedRef, event.reviewId,
      event.expectedProtectedHead, event.candidateCommit, event.candidateTree, event.policyRevision,
      event.requiredReviewRevision, event.requiredJobSetRevision, event.jobName, event.evidenceClass,
      admissionGeneration, now, now
    );
    this.#database.prepare("UPDATE native_event_inbox SET demand_id = ? WHERE event_id = ?").run(demandId, event.eventId);
  }

  private replayInTransaction(
    event: NativeReviewJobEvent,
    eventDigest: string,
    tupleDigest: string
  ): NativeEventIntakeResult {
    const existingEvent = stringField(this.#database.prepare(
      "SELECT event_digest FROM native_event_replay_fences WHERE event_id = ?"
    ).get(event.eventId), "event_digest");
    if (existingEvent !== undefined) return existingEvent === eventDigest ? "accepted" : "conflict";
    const existingTuple = stringField(this.#database.prepare(`
      SELECT tuple_digest FROM review_job_replay_fences WHERE review_id = ? AND job_name = ?
    `).get(event.reviewId, event.jobName), "tuple_digest");
    if (existingTuple === undefined) return "new";
    if (existingTuple !== tupleDigest) return "conflict";
    if (this.fenceCount("native_event_replay_fences") >= replayFenceLimit) return "full";
    this.#database.prepare("INSERT INTO native_event_replay_fences(event_id, event_digest) VALUES (?, ?)")
      .run(event.eventId, eventDigest);
    return "accepted";
  }

  private fenceCount(table: "native_event_replay_fences" | "review_job_replay_fences"): number {
    const row = this.#database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    const total = numberField(row, "total");
    if (total === undefined) throw new UserError("native ordinary database contains an invalid fence count");
    return total;
  }

  private nonterminalDemandCount(): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS total FROM demands WHERE state IN ('queued','preparing','claimed','reported')
    `).get();
    const total = numberField(row, "total");
    if (total === undefined) throw new UserError("native ordinary database contains an invalid demand count");
    return total;
  }

  private finish<T>(result: T): T {
    this.#database.exec("COMMIT");
    return result;
  }
}

function activeAdmission(value: unknown): {
  readonly generation: string;
  readonly policy: ReturnType<typeof parseNativeAdmissionPolicy>;
  readonly expiresAt: number;
} | undefined {
  if (value === undefined) return undefined;
  const generation = stringField(value, "admission_generation");
  const policyJson = stringField(value, "policy_json");
  const expiresAt = numberField(value, "expires_at");
  if (generation === undefined || policyJson === undefined || expiresAt === undefined) {
    throw new UserError("native ordinary database contains an invalid admission");
  }
  try {
    return { generation, policy: parseNativeAdmissionPolicy(JSON.parse(policyJson)), expiresAt };
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("native ordinary database contains malformed admission JSON", { cause: error });
    throw error;
  }
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
