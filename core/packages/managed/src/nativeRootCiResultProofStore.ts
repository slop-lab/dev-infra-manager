import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "@slop-lab/dim-core";
import { parseNativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import { parseNativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import type {
  NativeRootCiCurrentResultProof,
  NativeRootCiCurrentResultProofRequest
} from "./nativeRootCiResultProofModel.js";
import {
  nativeRootCiTerminalEventDigest,
  parseNativeRootCiHostResultRequest
} from "./nativeRootCiResultProtocol.js";

type ProofStoreContext = {
  readonly generationId: string;
  readonly serviceEpochId: string;
  readonly capacityConfigDigest: string;
  readonly now: () => number;
};

export type NativeRootCiCurrentResultProofLookup =
  | { readonly kind: "found"; readonly proof: Omit<NativeRootCiCurrentResultProof,
    "schemaVersion" | "serviceId" | "requestId" | "servingGenerationId" | "projectId" | "repositoryId"> }
  | { readonly kind: "conflict" | "not-found" };

export class NativeRootCiResultProofStore {
  constructor(readonly database: DatabaseSync, readonly context: ProofStoreContext) {}

  current(projectId: string, request: NativeRootCiCurrentResultProofRequest): NativeRootCiCurrentResultProofLookup {
    const event = request.terminalEvent.payload;
    const row = this.database.prepare(`SELECT h.*, o.terminal_event_json outbox_event_json,
      o.terminal_event_digest outbox_event_digest, o.state outbox_state, o.created_at outbox_created_at,
      c.service_epoch_id, c.generation_id claim_generation_id, c.capacity_config_digest,
      c.host_id claim_host_id, c.admission_generation claim_admission_generation,
      c.state claim_state, r.state receipt_state, r.attempt_id receipt_attempt_id,
      r.descriptor_digest receipt_descriptor_digest, r.assignment_json, r.issuance_json,
      r.lease_expires_at, d.state demand_state, d.admission_generation, d.review_id, d.job_name,
      d.expected_protected_head, d.candidate_commit, d.candidate_tree,
      e.root_sequence event_root_sequence, e.root_commit event_root_commit,
      e.root_tree event_root_tree, e.policy_digest event_policy_digest,
      a.state admission_state, a.lease_expires_at admission_expires_at,
      a.control_plane_generation_id, a.capacity_config_digest admission_capacity_digest,
      a.root_sequence admission_root_sequence, a.root_commit admission_root_commit,
      a.root_tree admission_root_tree, a.policy_digest admission_policy_digest
      FROM native_root_ci_host_results h
      JOIN native_root_ci_report_outbox o ON o.claim_id = h.claim_id
      JOIN native_root_ci_claims c ON c.claim_id = h.claim_id
      JOIN native_root_ci_claim_receipts r ON r.claim_id = h.claim_id
      JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
      JOIN native_root_ci_event_receipts e
        ON e.admission_generation = d.admission_generation AND e.event_id = d.event_id
      JOIN native_root_admissions a ON a.admission_generation = c.admission_generation
      WHERE d.project_id = ? AND d.repository_id = 'root' AND d.review_id = ? AND d.job_name = ?
        AND h.attempt_id = ? AND h.descriptor_digest = ? AND h.host_id = ? AND c.capacity = ?
        AND c.admission_generation = ? AND d.expected_protected_head = ?`).get(
      projectId, event.reviewId, event.descriptor.jobName, event.attemptId, event.descriptorDigest,
      event.hostId, event.capacity, event.descriptor.admissionGeneration, event.descriptor.expectedProtectedHead);
    if (row === undefined) return { kind: "not-found" };
    try {
      return this.proof(row, request);
    } catch (error) {
      if (error instanceof UserError || error instanceof SyntaxError) return { kind: "conflict" };
      throw error;
    }
  }

  private proof(row: unknown, request: NativeRootCiCurrentResultProofRequest): NativeRootCiCurrentResultProofLookup {
    const eventJson = JSON.stringify(request.terminalEvent);
    const digest = nativeRootCiTerminalEventDigest(request.terminalEvent);
    const storedRequest = parseNativeRootCiHostResultRequest(JSON.parse(field(row, "request_json")));
    const assignment = parseNativeAttemptAssignment(JSON.parse(field(row, "assignment_json")));
    const issuance = parseNativeJobAttemptIssuance(JSON.parse(field(row, "issuance_json")));
    const event = request.terminalEvent.payload;
    const descriptor = event.descriptor;
    if (request.generationId !== this.context.generationId
      || field(row, "claim_generation_id") !== this.context.generationId
      || field(row, "control_plane_generation_id") !== this.context.generationId
      || field(row, "capacity_config_digest") !== this.context.capacityConfigDigest
      || field(row, "admission_capacity_digest") !== this.context.capacityConfigDigest
      || field(row, "claim_state") !== "reported"
      || field(row, "receipt_state") !== "reported" || field(row, "demand_state") !== "reported"
      || field(row, "admission_state") !== "active"
      || field(row, "terminal_event_json") !== eventJson || field(row, "terminal_event_digest") !== digest
      || field(row, "outbox_event_json") !== eventJson || field(row, "outbox_event_digest") !== digest
      || field(row, "outbox_state") !== "pending" || integer(row, "cleanup_complete") !== 1
      || integer(row, "created_at") !== integer(row, "outbox_created_at")
      || JSON.stringify(storedRequest) !== field(row, "request_json")
      || storedRequest.claimId !== field(row, "claim_id")
      || storedRequest.requestId !== field(row, "request_id")
      || storedRequest.generationId !== field(row, "generation_id")
      || storedRequest.resourceId !== storedRequest.claimId
      || storedRequest.resourceId !== field(row, "cleanup_resource_id")
      || storedRequest.cleanupComplete !== true
      || !isDeepStrictEqual(storedRequest.terminalEvent, request.terminalEvent)
      || event.hostId !== field(row, "claim_host_id")
      || descriptor.admissionGeneration !== field(row, "claim_admission_generation")
      || event.attemptId !== field(row, "receipt_attempt_id")
      || event.descriptorDigest !== field(row, "receipt_descriptor_digest")
      || event.reviewId !== assignment.reviewId || event.reviewId !== issuance.reviewId
      || event.attemptId !== assignment.attemptId || event.attemptId !== issuance.attemptId
      || event.descriptorDigest !== assignment.descriptorDigest
      || event.descriptorDigest !== issuance.descriptorDigest
      || event.attempt !== issuance.attempt || event.hostId !== assignment.hostId || event.hostId !== issuance.hostId
      || event.capacity !== assignment.capacity || event.capacity !== issuance.capacity
      || !isDeepStrictEqual(descriptor, assignment.descriptor) || !isDeepStrictEqual(descriptor, issuance.descriptor)
      || descriptor.candidateCommit !== field(row, "candidate_commit")
      || descriptor.candidateTree !== field(row, "candidate_tree")
      || field(row, "event_root_commit") !== field(row, "admission_root_commit")
      || field(row, "event_root_tree") !== field(row, "admission_root_tree")
      || field(row, "event_policy_digest") !== field(row, "admission_policy_digest")
      || integer(row, "event_root_sequence") !== integer(row, "admission_root_sequence")) {
      return { kind: "conflict" };
    }
    return { kind: "found", proof: {
      claimId: field(row, "claim_id"), serviceEpochId: field(row, "service_epoch_id"),
      admissionGeneration: field(row, "admission_generation"),
      rootSequence: integer(row, "admission_root_sequence"), rootCommit: field(row, "admission_root_commit"),
      rootTree: field(row, "admission_root_tree"), cleanupComplete: true,
      terminalEvent: request.terminalEvent, terminalEventDigest: digest
    } };
  }

}

function field(row: unknown, name: string): string {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  if (typeof value !== "string") throw new UserError("ordinary CI current-result proof state is invalid");
  return value;
}
function integer(row: unknown, name: string): number {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new UserError("ordinary CI current-result proof state is invalid");
  }
  return value;
}
