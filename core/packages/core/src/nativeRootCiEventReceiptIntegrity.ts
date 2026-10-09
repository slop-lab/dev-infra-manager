import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import { parseNativeRootCiPolicyProof } from "./nativeRootCiProofModel.js";
import { canonicalNativeRootCiReviewEvent, parseNativeRootCiReviewEvent } from "./nativeRootCiReviewEvent.js";

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
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("ordinary CI event receipt state is invalid", { cause: error });
  } finally {
    database.close();
  }
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
