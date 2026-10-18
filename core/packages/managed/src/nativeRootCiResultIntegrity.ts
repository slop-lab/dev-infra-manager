import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "@slop-lab/dim-core";
import { parseNativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import { parseNativeAttemptAssignment } from "./nativeOrdinaryAuthorityModel.js";
import {
  nativeRootCiTerminalEventDigest,
  parseNativeRootCiHostResultRequest,
  parseNativeRootCiStatusAcknowledgement
} from "./nativeRootCiResultProtocol.js";

export function assertNativeRootCiResultIntegrity(database: DatabaseSync, limit: number, reporterUsername?: string): void {
  try {
    assertResults(database, limit, reporterUsername);
  } catch (error) {
    if (error instanceof UserError && error.message === "ordinary CI event receipt state is invalid") throw error;
    throw new UserError("ordinary CI event receipt state is invalid", { cause: error });
  }
}

export function assertNativeRootCiSelectedResultIntegrity(row: unknown, reporterUsername: string): void {
  try {
    assertResult(record(row), reporterUsername);
  } catch (error) {
    if (error instanceof UserError && error.message === "ordinary CI event receipt state is invalid") throw error;
    throw new UserError("ordinary CI event receipt state is invalid", { cause: error });
  }
}

function assertResults(database: DatabaseSync, limit: number, reporterUsername: string | undefined): void {
  const resultCount = count(database, "native_root_ci_host_results");
  const outboxCount = count(database, "native_root_ci_report_outbox");
  if (resultCount > limit || resultCount !== outboxCount) invalid();
  const rows = database.prepare(`SELECT h.*, o.terminal_event_json AS outbox_event_json,
    o.terminal_event_digest AS outbox_event_digest, o.state AS outbox_state,
    o.acknowledgement_json, o.acknowledgement_digest,
    o.created_at AS outbox_created_at, o.delivered_at,
    c.host_id AS claim_host_id,
    c.generation_id AS claim_generation_id, c.state AS claim_state, c.demand_id,
    r.state AS receipt_state, r.attempt_id AS receipt_attempt_id,
    r.descriptor_digest AS receipt_descriptor_digest, r.assignment_json, r.issuance_json,
    r.recovery_request_id, r.revocation_json, r.released_at, d.state AS demand_state
    FROM native_root_ci_host_results h
    JOIN native_root_ci_report_outbox o ON o.claim_id = h.claim_id
    JOIN native_root_ci_claims c ON c.claim_id = h.claim_id
    JOIN native_root_ci_claim_receipts r ON r.claim_id = h.claim_id
    JOIN native_root_ci_demands d ON d.demand_id = c.demand_id
    ORDER BY h.created_at, h.claim_id`).all();
  if (rows.length !== resultCount) invalid();
  for (const value of rows) assertResult(record(value), reporterUsername);
}

function assertResult(row: Readonly<Record<string, unknown>>, reporterUsername: string | undefined): void {
  const requestJson = text(row, "request_json");
  const request = parseNativeRootCiHostResultRequest(JSON.parse(requestJson));
  const eventJson = text(row, "terminal_event_json");
  const digest = nativeRootCiTerminalEventDigest(request.terminalEvent);
  const event = request.terminalEvent.payload;
  const assignment = parseNativeAttemptAssignment(JSON.parse(text(row, "assignment_json")));
  const issuance = parseNativeJobAttemptIssuance(JSON.parse(text(row, "issuance_json")));
  if (JSON.stringify(request) !== requestJson
    || JSON.stringify(request.terminalEvent) !== eventJson
    || request.claimId !== text(row, "claim_id")
    || request.requestId !== text(row, "request_id")
    || request.generationId !== text(row, "generation_id")
    || request.generationId !== text(row, "claim_generation_id")
    || request.resourceId !== request.claimId
    || request.resourceId !== text(row, "cleanup_resource_id")
    || request.cleanupComplete !== true || integer(row, "cleanup_complete") !== 1
    || event.attemptId !== text(row, "attempt_id")
    || event.descriptorDigest !== text(row, "descriptor_digest")
    || event.hostId !== text(row, "host_id") || event.hostId !== text(row, "claim_host_id")
    || digest !== text(row, "terminal_event_digest")
    || eventJson !== text(row, "outbox_event_json")
    || digest !== text(row, "outbox_event_digest")
    || integer(row, "created_at") !== integer(row, "outbox_created_at")
    || event.attemptId !== text(row, "receipt_attempt_id")
    || event.descriptorDigest !== text(row, "receipt_descriptor_digest")
    || event.reviewId !== assignment.reviewId || event.reviewId !== issuance.reviewId
    || event.attemptId !== assignment.attemptId || event.attemptId !== issuance.attemptId
    || event.attempt !== issuance.attempt
    || event.hostId !== assignment.hostId || event.hostId !== issuance.hostId
    || event.capacity !== assignment.capacity || event.capacity !== issuance.capacity
    || !isDeepStrictEqual(event.descriptor, assignment.descriptor)
    || !isDeepStrictEqual(event.descriptor, issuance.descriptor)) invalid();
  const state = text(row, "outbox_state");
  if (state === "pending") {
    if (row["acknowledgement_json"] !== null || row["acknowledgement_digest"] !== null
      || row["delivered_at"] !== null || text(row, "demand_state") !== "reported"
      || !((text(row, "claim_state") === "reported" && text(row, "receipt_state") === "reported")
        || (text(row, "claim_state") === "recovering" && text(row, "receipt_state") === "recovering"
          && typeof row["recovery_request_id"] === "string"))
      || row["revocation_json"] !== null || row["released_at"] !== null
      || (text(row, "receipt_state") === "reported" && row["recovery_request_id"] !== null)) invalid();
    return;
  }
  if (text(row, "claim_state") !== "released" || text(row, "receipt_state") !== "released"
    || text(row, "demand_state") !== "completed" || typeof row["released_at"] !== "number") invalid();
  if (state === "denied") {
    if (row["acknowledgement_json"] !== null || row["acknowledgement_digest"] !== null
      || row["delivered_at"] !== null || typeof row["recovery_request_id"] !== "string"
      || typeof row["revocation_json"] !== "string") invalid();
    return;
  }
  if (state !== "delivered" || row["recovery_request_id"] !== null || row["revocation_json"] !== null) invalid();
  const acknowledgementJson = text(row, "acknowledgement_json");
  const acknowledgementDigest = `sha256:${createHash("sha256").update(acknowledgementJson, "utf8").digest("hex")}`;
  const acknowledgement = record(JSON.parse(acknowledgementJson));
  const storedReporter = text(acknowledgement, "reporterUsername");
  parseNativeRootCiStatusAcknowledgement(acknowledgement, request.terminalEvent, reporterUsername ?? storedReporter);
  if (text(row, "acknowledgement_digest") !== acknowledgementDigest
    || !Number.isSafeInteger(row["delivered_at"])
    || Number(row["delivered_at"]) < integer(row, "outbox_created_at")) invalid();
}

function count(database: DatabaseSync, table: string): number {
  return integer(record(database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get()), "value");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function text(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") invalid();
  return value;
}

function integer(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid();
  return value;
}

function invalid(): never {
  throw new UserError("ordinary CI event receipt state is invalid");
}
