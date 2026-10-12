import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import { assertNativeRootCiSelectedResultIntegrity } from "./nativeRootCiResultIntegrity.js";
import type {
  NativeRootCiCurrentTerminalProof,
  NativeRootCiCurrentTerminalProofRequest
} from "./nativeRootCiTerminalResultProofModel.js";
import {
  nativeRootCiTerminalEventDigest,
  parseNativeRootCiHostResultRequest,
  parseNativeRootCiStatusAcknowledgement
} from "./nativeRootCiResultProtocol.js";

type TerminalProofStoreContext = {
  readonly generationId: string;
  readonly capacityConfigDigest: string;
  readonly reporterUsername: string;
  readonly now: () => number;
};

type TerminalProofBody = Omit<NativeRootCiCurrentTerminalProof,
  "schemaVersion" | "serviceId" | "requestId" | "servingGenerationId" | "projectId" | "repositoryId">;

export type NativeRootCiCurrentTerminalProofLookup =
  | { readonly kind: "found"; readonly proof: TerminalProofBody }
  | { readonly kind: "conflict" | "not-found" };

export class NativeRootCiTerminalResultProofStore {
  constructor(readonly database: DatabaseSync, readonly context: TerminalProofStoreContext) {}

  current(projectId: string, request: NativeRootCiCurrentTerminalProofRequest): NativeRootCiCurrentTerminalProofLookup {
    try {
      const event = request.terminalEvent.payload;
      const rows = this.database.prepare(`SELECT h.*, o.terminal_event_json outbox_event_json,
       o.terminal_event_digest outbox_event_digest, o.state outbox_state, o.acknowledgement_json,
       o.acknowledgement_digest, o.created_at outbox_created_at, o.delivered_at, c.service_epoch_id,
       c.generation_id claim_generation_id, c.capacity_config_digest, c.admission_generation claim_admission_generation,
       c.host_id claim_host_id, c.state claim_state, r.state receipt_state,
       r.attempt_id receipt_attempt_id, r.descriptor_digest receipt_descriptor_digest,
       r.assignment_json, r.issuance_json, r.recovery_request_id, r.revocation_json, r.released_at,
       d.state demand_state,
      e.root_sequence event_root_sequence, e.root_commit event_root_commit, e.root_tree event_root_tree,
      e.policy_digest event_policy_digest, a.state admission_state, a.lease_expires_at admission_expires_at,
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
        AND c.admission_generation = ? AND d.expected_protected_head = ? LIMIT 2`).all(
         projectId, event.reviewId, event.descriptor.jobName, event.attemptId, event.descriptorDigest,
         event.hostId, event.capacity, event.descriptor.admissionGeneration, event.descriptor.expectedProtectedHead);
      if (rows.length === 0) return { kind: "not-found" };
      if (rows.length !== 1) return { kind: "conflict" };
      const row = rows[0];
      assertNativeRootCiSelectedResultIntegrity(row, this.context.reporterUsername);
      return this.proof(row, request);
    } catch (error) {
      if (error instanceof UserError || error instanceof SyntaxError) return { kind: "conflict" };
      throw error;
    }
  }

  private proof(row: unknown, request: NativeRootCiCurrentTerminalProofRequest): NativeRootCiCurrentTerminalProofLookup {
    const eventJson = JSON.stringify(request.terminalEvent);
    const eventDigest = nativeRootCiTerminalEventDigest(request.terminalEvent);
    const storedRequest = parseNativeRootCiHostResultRequest(JSON.parse(field(row, "request_json")));
    const acknowledgementJson = field(row, "acknowledgement_json");
    parseNativeRootCiStatusAcknowledgement(
      JSON.parse(acknowledgementJson),
      request.terminalEvent,
      this.context.reporterUsername
    );
    if (request.generationId !== this.context.generationId
      || field(row, "generation_id") !== this.context.generationId
      || field(row, "claim_generation_id") !== this.context.generationId
      || field(row, "control_plane_generation_id") !== this.context.generationId
      || field(row, "capacity_config_digest") !== this.context.capacityConfigDigest
      || field(row, "admission_capacity_digest") !== this.context.capacityConfigDigest
      || field(row, "outbox_state") !== "delivered"
      || field(row, "claim_state") !== "released" || field(row, "receipt_state") !== "released"
      || field(row, "demand_state") !== "completed" || field(row, "admission_state") !== "active"
      || field(row, "terminal_event_json") !== eventJson || field(row, "terminal_event_digest") !== eventDigest
      || field(row, "outbox_event_json") !== eventJson || field(row, "outbox_event_digest") !== eventDigest
      || storedRequest.resourceId !== storedRequest.claimId
      || storedRequest.resourceId !== field(row, "cleanup_resource_id") || storedRequest.cleanupComplete !== true
      || integer(row, "cleanup_complete") !== 1
      || field(row, "claim_admission_generation") !== request.terminalEvent.payload.descriptor.admissionGeneration
      || integer(row, "event_root_sequence") !== integer(row, "admission_root_sequence")
      || field(row, "event_root_commit") !== field(row, "admission_root_commit")
      || field(row, "event_root_tree") !== field(row, "admission_root_tree")
      || field(row, "event_policy_digest") !== field(row, "admission_policy_digest")) {
      return { kind: "conflict" };
    }
    return { kind: "found", proof: {
      claimId: field(row, "claim_id"), resultGenerationId: field(row, "generation_id"),
      serviceEpochId: field(row, "service_epoch_id"), admissionGeneration: field(row, "claim_admission_generation"),
      rootSequence: integer(row, "admission_root_sequence"), rootCommit: field(row, "admission_root_commit"),
      rootTree: field(row, "admission_root_tree"), cleanupResourceId: field(row, "cleanup_resource_id"),
      cleanupComplete: true, terminalEventDigest: eventDigest,
      statusAcknowledgementJson: acknowledgementJson,
      statusAcknowledgementDigest: field(row, "acknowledgement_digest"),
      deliveredAt: integer(row, "delivered_at")
    } };
  }
}

function field(row: unknown, name: string): string {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  if (typeof value !== "string") throw new UserError("ordinary CI current-terminal proof state is invalid");
  return value;
}
function integer(row: unknown, name: string): number {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new UserError("ordinary CI current-terminal proof state is invalid");
  }
  return value;
}
