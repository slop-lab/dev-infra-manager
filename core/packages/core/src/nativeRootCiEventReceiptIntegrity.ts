import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import { parseNativeRootCiPolicyProof } from "./nativeRootCiProofModel.js";
import { canonicalNativeRootCiReviewEvent, parseNativeRootCiReviewEvent } from "./nativeRootCiReviewEvent.js";
import { parseNativeRootCiClaim } from "./nativeRootCiClaimProtocol.js";
import { parseNativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import { parseNativeJobAttemptIssuance, parseNativeJobAttemptRevocation } from "./nativeGitAttemptIssuerModel.js";
import { assertNativeRootCiResultIntegrity } from "./nativeRootCiResultIntegrity.js";

const receiptLimit = 100_000;

export function assertNativeRootCiEventReceiptIntegrity(file: string): void {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const count = number(record(database.prepare("SELECT COUNT(*) AS value FROM native_root_ci_event_receipts").get()), "value");
    if (count > receiptLimit) invalid();
    const rows = database.prepare(`SELECT r.*, a.ordinary_service_id AS admission_ordinary_service_id,
      a.control_plane_generation_id AS admission_generation_id, a.native_service_id AS admission_native_service_id,
      a.project_id AS admission_project_id, a.repository_id AS admission_repository_id,
      a.import_nonce AS admission_import_nonce, a.root_sequence AS admission_root_sequence,
      a.protected_ref AS admission_protected_ref, a.root_commit AS admission_root_commit,
      a.root_tree AS admission_root_tree, a.policy_digest AS admission_policy_digest,
      a.policy_json AS admission_policy_json, a.capacity_config_digest AS admission_capacity_digest
      FROM native_root_ci_event_receipts r JOIN native_root_admissions a
      ON a.admission_generation = r.admission_generation ORDER BY r.admission_generation, r.event_id`).iterate();
    let visited = 0;
    for (const value of rows) {
      visited += 1;
      if (visited > receiptLimit) invalid();
      assertRow(record(value));
    }
    if (visited !== count) invalid();
    assertDemands(database, count);
    assertClaims(database);
    assertNativeRootCiResultIntegrity(database, receiptLimit);
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("ordinary CI event receipt state is invalid", { cause: error });
  } finally {
    database.close();
  }
}

function assertDemands(database: DatabaseSync, receiptCount: number): void {
  const demandCount = number(record(database.prepare("SELECT COUNT(*) AS value FROM native_root_ci_demands").get()), "value");
  const rows = database.prepare(`SELECT d.*, r.project_id AS receipt_project_id,
    r.repository_id AS receipt_repository_id, r.root_protected_ref AS receipt_protected_ref,
    r.root_commit AS receipt_root_commit, r.root_sequence AS receipt_root_sequence,
    r.capacity_config_digest AS receipt_capacity_digest, r.event_json AS receipt_event_json,
    a.state AS admission_state, a.root_sequence AS current_root_sequence,
    a.root_commit AS current_root_commit
    FROM native_root_ci_demands d JOIN native_root_ci_event_receipts r
      ON r.admission_generation = d.admission_generation AND r.event_id = d.event_id
    JOIN native_root_admissions a ON a.admission_generation = d.admission_generation
    ORDER BY d.created_at, d.demand_id`).all();
  if (demandCount !== receiptCount || rows.length !== demandCount) invalid();
  for (const value of rows) {
    const row = record(value);
    const event = parseNativeRootCiReviewEvent(JSON.parse(text(row, "receipt_event_json")));
    const state = text(row, "state");
    const terminalAt = row.terminal_at;
    if (text(row, "project_id") !== text(row, "receipt_project_id")
      || text(row, "repository_id") !== text(row, "receipt_repository_id")
      || text(row, "protected_ref") !== text(row, "receipt_protected_ref")
      || text(row, "expected_protected_head") !== text(row, "receipt_root_commit")
      || number(row, "root_sequence") !== number(row, "receipt_root_sequence")
      || text(row, "root_commit") !== text(row, "receipt_root_commit")
      || text(row, "capacity_config_digest") !== text(row, "receipt_capacity_digest")
      || text(row, "review_id") !== event.reviewId || text(row, "candidate_commit") !== event.candidateCommit
      || text(row, "candidate_tree") !== event.candidateTree || text(row, "policy_revision") !== event.policyRevision
      || text(row, "required_review_revision") !== event.requiredReviewRevision
      || text(row, "required_job_set_revision") !== event.requiredJobSetRevision
      || text(row, "execution_kind") !== event.executionKind || text(row, "job_name") !== event.jobName
      || text(row, "evidence_class") !== event.evidenceClass
      || (state === "queued" || state === "preparing") && (text(row, "admission_state") !== "active"
        || number(row, "root_sequence") !== number(row, "current_root_sequence")
        || text(row, "root_commit") !== text(row, "current_root_commit"))
      || (state === "queued" || state === "preparing" || state === "active" || state === "reported")
        && terminalAt !== null
      || (state === "completed" || state === "superseded") && typeof terminalAt !== "number") invalid();
  }
}

function assertClaims(database: DatabaseSync): void {
  const claims = database.prepare(`SELECT c.*, d.state AS demand_state, d.event_id AS demand_event_id,
    d.admission_generation AS demand_admission_generation, r.event_json,
    r.event_digest AS receipt_event_digest, r.ordinary_service_id AS receipt_service_id,
    r.control_plane_generation_id AS receipt_generation_id, r.project_id AS receipt_project_id,
    r.import_nonce AS receipt_import_nonce, r.policy_digest AS receipt_policy_digest,
    r.root_sequence AS receipt_root_sequence, r.root_protected_ref AS receipt_protected_ref,
    r.root_commit AS receipt_root_commit, r.root_tree AS receipt_root_tree,
    r.capacity_config_digest AS receipt_capacity_digest, e.generation_id AS epoch_generation_id,
    cr.state AS claim_receipt_state, cr.attempt_id AS claim_receipt_attempt_id,
    cr.descriptor_digest AS claim_receipt_descriptor_digest, cr.assignment_json, cr.issuance_json,
    cr.recovery_request_id, cr.revocation_json, cr.released_at, o.state AS outbox_state
    FROM native_root_ci_claims c JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
    JOIN native_root_ci_event_receipts r
      ON r.admission_generation = d.admission_generation AND r.event_id = d.event_id
    JOIN native_root_ci_service_epochs e ON e.epoch_id = c.service_epoch_id
    LEFT JOIN native_root_ci_claim_receipts cr ON cr.claim_id = c.claim_id
    LEFT JOIN native_root_ci_report_outbox o ON o.claim_id = c.claim_id
    ORDER BY c.created_at, c.claim_id`).all();
  const count = number(record(database.prepare("SELECT COUNT(*) AS value FROM native_root_ci_claims").get()), "value");
  if (claims.length !== count || count > receiptLimit) invalid();
  for (const value of claims) {
    const row = record(value);
    const claim = parseNativeRootCiClaim(JSON.parse(text(row, "response_json")));
    if (claim.claimId !== text(row, "claim_id") || claim.issuanceRequestId !== claim.claimId
      || claim.requestId !== text(row, "request_id") || claim.demandId !== text(row, "demand_id")
      || claim.serviceId !== text(row, "receipt_service_id")
      || claim.generationId !== text(row, "receipt_generation_id")
      || claim.generationId !== text(row, "epoch_generation_id")
      || claim.admissionGeneration !== text(row, "admission_generation")
      || claim.admissionGeneration !== text(row, "demand_admission_generation")
      || claim.event.eventId !== text(row, "event_id") || claim.event.eventId !== text(row, "demand_event_id")
      || claim.eventDigest !== text(row, "receipt_event_digest")
      || canonicalNativeRootCiReviewEvent(claim.event) !== text(row, "event_json")
      || claim.admission.projectId !== text(row, "receipt_project_id")
      || claim.admission.importNonce !== text(row, "receipt_import_nonce")
      || claim.admission.policyDigest !== text(row, "receipt_policy_digest")
      || claim.admission.rootSequence !== number(row, "receipt_root_sequence")
      || claim.admission.protectedRef !== text(row, "receipt_protected_ref")
      || claim.admission.rootCommit !== text(row, "receipt_root_commit")
      || claim.admission.rootTree !== text(row, "receipt_root_tree")
      || claim.admission.capacityConfigDigest !== text(row, "receipt_capacity_digest")
      || claim.hostId !== text(row, "host_id") || claim.capacity !== text(row, "capacity")
      || claim.serviceEpochId !== text(row, "service_epoch_id") || claim.generationId !== text(row, "generation_id")
      || claim.admission.capacityConfigDigest !== text(row, "capacity_config_digest")
      || claim.runnerBaseImage !== text(row, "runner_base_image") || claim.jobBaseImage !== text(row, "job_base_image")
      || JSON.stringify(claim.bounds) !== text(row, "bounds_json")) invalid();
    assertClaimLifecycle(row, claim.claimId);
  }
}

function assertClaimLifecycle(row: Readonly<Record<string, unknown>>, claimId: string): void {
  const state = text(row, "state");
  const demandState = text(row, "demand_state");
  if (state === "preparing") {
    if ((demandState !== "preparing" && demandState !== "superseded") || row.claim_receipt_state !== null) invalid();
    return;
  }
  const receiptState = text(row, "claim_receipt_state");
  const assignment = parseNativeAttemptAssignment(JSON.parse(text(row, "assignment_json")));
  const issuance = parseNativeJobAttemptIssuance(JSON.parse(text(row, "issuance_json")));
  if (assignment.attemptId !== issuance.attemptId || assignment.attemptId !== text(row, "claim_receipt_attempt_id")
    || assignment.descriptorDigest !== issuance.descriptorDigest
    || assignment.descriptorDigest !== text(row, "claim_receipt_descriptor_digest")) invalid();
  const outboxState = row.outbox_state;
  if (state === "active" && (demandState !== "active" || receiptState !== "active" || outboxState !== null)) invalid();
  if (state === "reported" && (demandState !== "reported" || receiptState !== "reported"
    || outboxState !== "pending")) invalid();
  if (state === "recovering" && (receiptState !== "recovering"
    || (demandState !== "preparing" && demandState !== "active" && demandState !== "reported")
    || (demandState === "reported" && outboxState !== "pending")
    || typeof row.recovery_request_id !== "string")) invalid();
  if (state === "released") {
    if (receiptState !== "released" || typeof row.released_at !== "number") invalid();
    if (demandState === "completed" && outboxState === "delivered") {
      if (row.recovery_request_id !== null || row.revocation_json !== null) invalid();
    } else if ((demandState === "completed" && outboxState === "denied")
      || (demandState === "superseded" && outboxState === null)) {
      if (typeof row.recovery_request_id !== "string") invalid();
      const revocation = parseNativeJobAttemptRevocation(JSON.parse(text(row, "revocation_json")));
      if (revocation.attemptId !== issuance.attemptId || revocation.descriptorDigest !== issuance.descriptorDigest) invalid();
    } else invalid();
  }
  if (issuance.issuanceRequestId !== claimId) invalid();
}

function assertRow(row: Readonly<Record<string, unknown>>): void {
  const eventJson = text(row, "event_json");
  if (Buffer.byteLength(eventJson) < 1 || Buffer.byteLength(eventJson) > 65_536) invalid();
  const event = parseNativeRootCiReviewEvent(JSON.parse(eventJson));
  const canonical = canonicalNativeRootCiReviewEvent(event);
  const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  if (canonical !== eventJson || digest !== text(row, "event_digest") || event.eventId !== text(row, "event_id")
    || event.projectId !== text(row, "project_id") || event.repositoryId !== text(row, "repository_id")
    || event.protectedRef !== text(row, "root_protected_ref")
    || event.expectedProtectedHead !== text(row, "root_commit")) invalid();
  const generation = text(row, "admission_generation_id");
  const projectId = text(row, "admission_project_id");
  const proof = parseNativeRootCiPolicyProof({ schemaVersion: 1,
    serviceId: text(row, "admission_native_service_id"), requestId: "00000000-0000-4000-8000-000000000000",
    servingGenerationId: generation, projectId, repositoryId: "root", currentRoot: {
      importNonce: text(row, "admission_import_nonce"), sequence: number(row, "admission_root_sequence"),
      protectedRef: text(row, "admission_protected_ref"), commit: text(row, "admission_root_commit"),
      tree: text(row, "admission_root_tree"), policyDigest: text(row, "admission_policy_digest")
    }, policy: JSON.parse(text(row, "admission_policy_json")) }, { serviceId: "native-main", generationId: generation,
    requestId: "00000000-0000-4000-8000-000000000000", projectId });
  const receiptSequence = number(row, "root_sequence");
  if (text(row, "ordinary_service_id") !== text(row, "admission_ordinary_service_id")
    || text(row, "control_plane_generation_id") !== generation
    || text(row, "native_service_id") !== proof.serviceId || event.projectId !== projectId
    || text(row, "repository_id") !== text(row, "admission_repository_id")
    || text(row, "import_nonce") !== proof.currentRoot.importNonce
    || text(row, "policy_digest") !== proof.currentRoot.policyDigest
    || text(row, "capacity_config_digest") !== text(row, "admission_capacity_digest")
    || text(row, "root_protected_ref") !== proof.currentRoot.protectedRef
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(row, "root_tree"))
    || text(row, "root_tree").length !== text(row, "root_commit").length
    || event.policyRevision !== proof.policy.policyRevision
    || event.requiredReviewRevision !== proof.policy.requiredReviewRevision
    || event.requiredJobSetRevision !== proof.policy.requiredJobSetRevision
    || !proof.policy.requiredJobs.some((job) => job.name === event.jobName && job.kind === "ordinary-sysbox")
    || receiptSequence > proof.currentRoot.sequence
    || receiptSequence === proof.currentRoot.sequence && (text(row, "root_commit") !== proof.currentRoot.commit
      || text(row, "root_tree") !== proof.currentRoot.tree)) invalid();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function text(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key]; if (typeof value !== "string") invalid(); return value;
}
function number(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key]; if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(); return value;
}
function invalid(): never { throw new UserError("ordinary CI event receipt state is invalid"); }
