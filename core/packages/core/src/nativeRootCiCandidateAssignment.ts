import type { DatabaseSync } from "node:sqlite";
import type { NativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import { lifecycleText, parseStoredAssignment } from "./nativeRootCiClaimLifecycleRows.js";

export function readNativeRootCiCandidateAssignment(input: {
  readonly database: DatabaseSync;
  readonly serviceEpochId: string;
  readonly generationId: string;
  readonly now: number;
  readonly claimId: string;
  readonly hostId: string;
  readonly attemptId: string;
  readonly descriptorDigest: string;
}): NativeAttemptAssignment | undefined {
  const row = input.database.prepare(`SELECT r.assignment_json
    FROM native_root_ci_claims c JOIN native_root_ci_claim_receipts r ON r.claim_id = c.claim_id
    JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
    JOIN native_root_ci_event_receipts e
      ON e.admission_generation = d.admission_generation AND e.event_id = d.event_id
    JOIN native_root_admissions a ON a.admission_generation = c.admission_generation
    JOIN native_root_ci_service_epochs s ON s.epoch_id = c.service_epoch_id
    WHERE c.claim_id = ? AND c.host_id = ? AND c.state = 'active' AND d.state = 'active'
      AND r.state = 'active' AND r.attempt_id = ? AND r.descriptor_digest = ?
      AND r.lease_expires_at > ? AND a.state = 'active' AND a.lease_expires_at > ?
      AND s.epoch_id = ? AND s.generation_id = ? AND s.active = 1
      AND a.control_plane_generation_id = c.generation_id
      AND a.capacity_config_digest = c.capacity_config_digest
      AND a.root_sequence = e.root_sequence AND a.root_commit = e.root_commit
      AND a.root_tree = e.root_tree AND a.policy_digest = e.policy_digest`).get(
    input.claimId, input.hostId, input.attemptId, input.descriptorDigest, input.now, input.now,
    input.serviceEpochId, input.generationId);
  if (row === undefined) return undefined;
  const assignment = lifecycleText(row, "assignment_json");
  return assignment === undefined ? undefined : parseStoredAssignment(assignment);
}
