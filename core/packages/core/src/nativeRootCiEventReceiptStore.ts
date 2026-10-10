import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { NativeRootCiEventReceiptRequest } from "./nativeRootCiEventReceiptModel.js";
import { parseNativeRootCiPolicyProof, type NativeRootCiPolicyProof,
  type NativeRootCiReviewEventProof } from "./nativeRootCiProofModel.js";

const receiptLimit = 100_000;

export type NativeRootCiEventReceiptStoreContext = {
  readonly ordinaryServiceId: string;
  readonly controlPlaneGenerationId: string;
  readonly capacityConfigDigest: string;
  readonly activated: () => boolean;
  readonly activationBound: () => boolean;
  readonly now: () => number;
};
export type ReceiptPreflight = { readonly kind: "ready"; readonly admission: ReceiptAdmission }
  | { readonly kind: "replay" } | { readonly kind: "conflict" }
  | { readonly kind: "not-found" } | { readonly kind: "full" };
export type ReceiptCommit = Exclude<ReceiptPreflight, { readonly kind: "ready" }>;
export type ReceiptAdmission = {
  readonly generation: string;
  readonly proof: NativeRootCiPolicyProof;
  readonly ordinaryServiceId: string;
  readonly capacityConfigDigest: string;
};

export class NativeRootCiEventReceiptStore {
  constructor(readonly database: DatabaseSync, readonly context: NativeRootCiEventReceiptStoreContext) {}

  preflight(request: NativeRootCiEventReceiptRequest): ReceiptPreflight {
    return this.readTransaction(() => this.evaluate(request));
  }

  commit(request: NativeRootCiEventReceiptRequest, proof: NativeRootCiReviewEventProof): ReceiptCommit {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.context.activated() || !this.context.activationBound()) return this.finish({ kind: "conflict" });
      const result = this.evaluate(request);
      if (result.kind === "not-found") return this.finish({ kind: "conflict" });
      if (result.kind !== "ready") return this.finish(result);
      if (!proofMatches(result.admission, request, proof)) return this.finish({ kind: "conflict" });
      const root = proof.currentRoot;
      this.database.prepare(`INSERT INTO native_root_ci_event_receipts
        (admission_generation, event_id, event_digest, event_json, ordinary_service_id,
        control_plane_generation_id, native_service_id, project_id, repository_id, import_nonce,
        policy_digest, root_sequence, root_protected_ref, root_commit, root_tree,
        capacity_config_digest, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'root', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        request.admissionGeneration, request.event.eventId, request.eventDigest, request.canonicalEvent,
        result.admission.ordinaryServiceId, proof.servingGenerationId, proof.serviceId, proof.projectId,
        root.importNonce, root.policyDigest, root.sequence, root.protectedRef, root.commit, root.tree,
        result.admission.capacityConfigDigest, this.context.now());
      const now = this.context.now();
      const event = request.event;
      this.database.prepare(`INSERT INTO native_root_ci_demands
        (demand_id, admission_generation, event_id, project_id, repository_id, protected_ref, review_id,
        expected_protected_head, candidate_commit, candidate_tree, policy_revision, required_review_revision,
        required_job_set_revision, execution_kind, job_name, evidence_class, capacity_config_digest,
        root_sequence, root_commit, state, created_at, updated_at, terminal_at)
        VALUES (?, ?, ?, ?, 'root', ?, ?, ?, ?, ?, ?, ?, ?, 'ordinary-sysbox', ?, 'candidate-controlled',
          ?, ?, ?, 'queued', ?, ?, NULL)`).run(randomUUID(), request.admissionGeneration, event.eventId,
        event.projectId, event.protectedRef, event.reviewId, event.expectedProtectedHead, event.candidateCommit,
        event.candidateTree, event.policyRevision, event.requiredReviewRevision, event.requiredJobSetRevision,
        event.jobName, result.admission.capacityConfigDigest, root.sequence, root.commit, now, now);
      return this.finish({ kind: "replay" });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private evaluate(request: NativeRootCiEventReceiptRequest): ReceiptPreflight {
    const admission = this.activeAdmission(request, this.context.now());
    if (admission === undefined) return { kind: "not-found" };
    const receipt = record(this.database.prepare(`SELECT event_digest FROM native_root_ci_event_receipts
      WHERE admission_generation = ? AND event_id = ?`).get(request.admissionGeneration, request.event.eventId));
    if (receipt !== undefined) {
      const demand = this.database.prepare(`SELECT 1 FROM native_root_ci_demands
        WHERE admission_generation = ? AND event_id = ?`).get(request.admissionGeneration, request.event.eventId);
      if (demand === undefined) corrupted();
      return receipt.event_digest === request.eventDigest ? { kind: "replay" } : { kind: "conflict" };
    }
    if (scalar(this.database.prepare("SELECT COUNT(*) AS value FROM native_root_ci_event_receipts").get()) >= receiptLimit) {
      return { kind: "full" };
    }
    return eventMatches(admission, request) ? { kind: "ready", admission } : { kind: "conflict" };
  }

  private activeAdmission(request: NativeRootCiEventReceiptRequest, now: number): ReceiptAdmission | undefined {
    const row = record(this.database.prepare(`SELECT * FROM native_root_admissions WHERE admission_generation = ?
      AND project_id = ? AND repository_id = 'root' AND state = 'active' AND lease_expires_at > ?
      AND ordinary_service_id = ? AND native_service_id = 'native-main'
      AND control_plane_generation_id = ? AND capacity_config_digest = ?`).get(request.admissionGeneration,
      request.event.projectId, now, this.context.ordinaryServiceId,
      this.context.controlPlaneGenerationId, this.context.capacityConfigDigest));
    if (row === undefined) return undefined;
    const generation = text(row, "control_plane_generation_id");
    const proof = parseNativeRootCiPolicyProof({ schemaVersion: 1, serviceId: text(row, "native_service_id"),
      requestId: "00000000-0000-4000-8000-000000000000", servingGenerationId: generation,
      projectId: text(row, "project_id"), repositoryId: "root", currentRoot: {
        importNonce: text(row, "import_nonce"), sequence: number(row, "root_sequence"),
        protectedRef: text(row, "protected_ref"), commit: text(row, "root_commit"),
        tree: text(row, "root_tree"), policyDigest: text(row, "policy_digest")
      }, policy: JSON.parse(text(row, "policy_json")) }, { serviceId: "native-main", generationId: generation,
      requestId: "00000000-0000-4000-8000-000000000000", projectId: request.event.projectId });
    return { generation: request.admissionGeneration, proof,
      ordinaryServiceId: text(row, "ordinary_service_id"),
      capacityConfigDigest: text(row, "capacity_config_digest") };
  }

  private readTransaction<Result>(operation: () => Result): Result {
    this.database.exec("BEGIN");
    try { return this.finish(operation()); }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private finish<Result>(result: Result): Result { this.database.exec("COMMIT"); return result; }
}

function eventMatches(admission: ReceiptAdmission, request: NativeRootCiEventReceiptRequest): boolean {
  const event = request.event;
  const { currentRoot, policy } = admission.proof;
  return event.protectedRef === currentRoot.protectedRef && event.expectedProtectedHead === currentRoot.commit
    && event.policyRevision === policy.policyRevision && event.requiredReviewRevision === policy.requiredReviewRevision
    && event.requiredJobSetRevision === policy.requiredJobSetRevision && policy.requiredJobs.some((job) =>
      job.name === event.jobName && job.kind === "ordinary-sysbox" && job.evidenceClass === "candidate-controlled");
}

function proofMatches(admission: ReceiptAdmission, request: NativeRootCiEventReceiptRequest,
  proof: NativeRootCiReviewEventProof): boolean {
  return eventMatches(admission, request) && isDeepStrictEqual(proof.event, request.event)
    && isDeepStrictEqual(proof.currentRoot, admission.proof.currentRoot)
    && isDeepStrictEqual(proof.policy, admission.proof.policy) && proof.serviceId === admission.proof.serviceId
    && proof.servingGenerationId === admission.proof.servingGenerationId
    && proof.projectId === admission.proof.projectId && proof.repositoryId === "root";
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)])) : undefined;
}
function text(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key]; if (typeof value !== "string") corrupted(); return value;
}
function number(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key]; if (typeof value !== "number") corrupted(); return value;
}
function scalar(value: unknown): number { const row = record(value); return row === undefined ? corrupted() : number(row, "value"); }
function corrupted(): never { throw new NativeRootCiEventReceiptStoreError(); }
export class NativeRootCiEventReceiptStoreError extends Error {
  readonly name = "NativeRootCiEventReceiptStoreError";
  constructor() { super("native root CI event receipt state is invalid"); }
}
