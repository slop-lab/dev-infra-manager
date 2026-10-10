import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { createNativeGitAttemptIssuerClient } from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { parseNativeRootCiClaim, type NativeRootCiClaim } from "../../../../core/packages/core/src/nativeRootCiClaimProtocol.js";
import type { NativeJobAttemptIssuance } from "../../../../core/packages/core/src/nativeGitAttemptIssuerModel.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import {
  claimRequest,
  hostAuthorization,
  post,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";

export async function activeAttempt(fixture: ReservationFixture, suffix: string) {
  const claimResponse = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"),
    claimRequest(`20000000-0000-4000-8000-000000000${suffix}`, "host-a", "primary"));
  expect(claimResponse.status).toBe(201);
  const claim = parseNativeRootCiClaim(claimResponse.body);
  const issuance = await issue(fixture, claim);
  const requestId = `30000000-0000-4000-8000-000000000${suffix}`;
  const activation = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"),
    { schemaVersion: 1, requestId, generationId, claim, issuance });
  expect(activation.status).toBe(201);
  const leaseExpiresAt = typeof activation.body === "object" && activation.body !== null
    ? Reflect.get(activation.body, "leaseExpiresAt") : undefined;
  if (typeof leaseExpiresAt !== "number") throw new TypeError("active lease expiry is unavailable");
  return { claim, issuance, leaseExpiresAt };
}

async function issue(fixture: ReservationFixture, claim: NativeRootCiClaim): Promise<NativeJobAttemptIssuance> {
  const transport = createNodeNativeGitAdmissionHttpClient();
  const client = createNativeGitAttemptIssuerClient({ config: {
    endpoint: "http://native-git:8080", serviceId: "native-main",
    attemptIssuer: { username: "ordinary-attempts", password: bundleSecrets.attemptIssuer }
  }, generationId, httpClient: { request: (input) => transport.request({ ...input, endpoint: fixture.nativeOrigin }) } });
  const descriptor = await client.loadDescriptor({ claim });
  return (await client.issueAttempt({ context: { claim }, descriptor })).issuance;
}

export function resultRequest(claim: NativeRootCiClaim, issuance: NativeJobAttemptIssuance, suffix: string) {
  const timestamp = "2026-10-10T00:00:00.000Z";
  return { schemaVersion: 2, requestId: `50000000-0000-4000-8000-000000000${suffix}`,
    generationId, claimId: claim.claimId, resourceId: claim.claimId, terminalEvent: {
      schemaVersion: 3, eventId: `60000000-0000-4000-8000-000000000${suffix}`, occurredAt: timestamp,
      eventType: "dim.ci.job.completed", payload: { executionKind: "ordinary-sysbox", reviewId: issuance.reviewId,
        attemptId: issuance.attemptId, attempt: issuance.attempt, descriptor: issuance.descriptor,
        descriptorDigest: issuance.descriptorDigest, hostId: issuance.hostId, capacity: issuance.capacity,
        startedAt: timestamp, finishedAt: timestamp, result: "success",
        completion: { kind: "exited", exitCode: 0 },
        stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
        stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false } } },
    cleanupComplete: true } as const;
}

export function resultRows(file: string): Readonly<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      results: database.prepare(`SELECT claim_id, request_id, cleanup_resource_id, cleanup_complete, request_json,
        terminal_event_json
        FROM native_root_ci_host_results`).all(),
      outbox: database.prepare(`SELECT claim_id, state, terminal_event_json
        FROM native_root_ci_report_outbox`).all(),
      demand: database.prepare("SELECT state FROM native_root_ci_demands").get()?.state,
      claim: database.prepare("SELECT state FROM native_root_ci_claims").get()?.state,
      receipt: database.prepare("SELECT state FROM native_root_ci_claim_receipts").get()?.state
    };
  } finally {
    database.close();
  }
}

export function enqueueAdditionalDemand(file: string): void {
  const database = new DatabaseSync(file);
  try {
    const receipt = database.prepare("SELECT * FROM native_root_ci_event_receipts").get();
    const demand = database.prepare("SELECT * FROM native_root_ci_demands").get();
    if (receipt === undefined || demand === undefined || typeof receipt.event_json !== "string") {
      throw new TypeError("source demand is unavailable");
    }
    const sourceEventId = sqliteText(receipt.event_id, "source event ID");
    const sourceDemandId = sqliteText(demand.demand_id, "source demand ID");
    const event = JSON.parse(receipt.event_json);
    event.reviewId = "8".repeat(64);
    event.eventId = createHash("sha256").update("dim-native-authoritative-review-event-v1\0")
      .update(JSON.stringify({ executionKind: "ordinary-sysbox", jobName: event.jobName, reviewId: event.reviewId }))
      .digest("hex");
    const eventJson = JSON.stringify(event);
    const eventDigest = `sha256:${createHash("sha256").update(eventJson).digest("hex")}`;
    database.exec("BEGIN IMMEDIATE");
    database.prepare(`INSERT INTO native_root_ci_event_receipts
      SELECT admission_generation, ?, ?, ?, ordinary_service_id, control_plane_generation_id, native_service_id,
        project_id, repository_id, import_nonce, policy_digest, root_sequence, root_protected_ref, root_commit,
        root_tree, capacity_config_digest, received_at + 1 FROM native_root_ci_event_receipts WHERE event_id = ?`)
      .run(event.eventId, eventDigest, eventJson, sourceEventId);
    database.prepare(`INSERT INTO native_root_ci_demands
      SELECT ?, admission_generation, ?, project_id, repository_id, protected_ref, review_id,
        expected_protected_head, candidate_commit, candidate_tree, policy_revision, required_review_revision,
        required_job_set_revision, execution_kind, job_name, evidence_class, capacity_config_digest,
        root_sequence, root_commit, 'queued', created_at + 1, updated_at + 1, NULL
      FROM native_root_ci_demands WHERE demand_id = ?`).run(randomUUID(), event.eventId, sourceDemandId);
    database.prepare("UPDATE native_root_ci_demands SET review_id = ? WHERE event_id = ?")
      .run(event.reviewId, event.eventId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally { database.close(); }
}

function sqliteText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is unavailable`);
  return value;
}
