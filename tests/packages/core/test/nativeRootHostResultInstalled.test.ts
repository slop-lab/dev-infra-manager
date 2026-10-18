import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/managed/src/nativeGitAdmissionHttpClient.js";
import { statusRecordPath } from "../../native-git/test/nativeOrdinaryStatusFixture.js";
import { rootRepository } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import {
  claimRequest,
  hostAuthorization,
  post,
  queryAuthorization,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, enqueueAdditionalDemand, resultRequest, resultRows } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native ordinary host results", () => {
  it("stores one cleaned terminal event and pending outbox while capacity stays fenced", async () => {
    // Given
    const fixture = await reservationFixture("installed-host-result");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "301");
    const request = resultRequest(active.claim, active.issuance, "501");
    const expiredAdmission = new DatabaseSync(fixture.database);
    expiredAdmission.prepare("UPDATE native_root_admissions SET lease_expires_at = 1 WHERE admission_generation = ?")
      .run(fixture.admissionGeneration);
    expiredAdmission.close();

    // When
    const accepted = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request);
    expect(accepted.status).toBe(202);
    const replay = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request);
    const mismatch = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), {
      ...request, terminalEvent: { ...request.terminalEvent, eventId: randomUUID() }
    });
    const competing = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest("20000000-0000-4000-8000-000000000599", "host-a", "primary"));
    const restarted = await fixture.restart();
    fixtures.push(restarted);
    const restartReplay = await post(restarted.origin, "/v1/host-results", hostAuthorization("host-a"), request);
    const restartCompeting = await post(restarted.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest("20000000-0000-4000-8000-000000000598", "host-a", "primary"));
    const database = new DatabaseSync(restarted.database);
    try {
      expect(() => database.prepare("UPDATE native_root_ci_host_results SET cleanup_complete = 0").run())
        .toThrow(/immutable/);
    } finally {
      database.close();
    }

    // Then
    expect([accepted.status, replay.status, restartReplay.status]).toEqual([202, 202, 202]);
    expect(mismatch.status).toBe(409);
    expect(accepted.body).toEqual({ schemaVersion: 1, claimId: active.claim.claimId, accepted: true });
    // Accepted results still fence capacity, but an idle worker must keep
    // polling while the asynchronous reporter obtains its acknowledgement.
    expect([competing.status, restartCompeting.status]).toEqual([204, 204]);
    expect(resultRows(restarted.database)).toEqual({
      results: [{ claim_id: active.claim.claimId, request_id: request.requestId,
        cleanup_resource_id: active.claim.claimId, cleanup_complete: 1,
        request_json: JSON.stringify(request), terminal_event_json: JSON.stringify(request.terminalEvent) }],
      outbox: [{ claim_id: active.claim.claimId, state: "pending",
        terminal_event_json: JSON.stringify(request.terminalEvent) }],
      demand: "reported",
      claim: "reported",
      receipt: "reported"
    });
  }, 20_000);

  it("replays identical status bytes after a lost reply and durably records the exact acknowledgement", async () => {
    // Given
    let loseReply = true;
    const sent: string[] = [];
    const statusResponses: number[] = [];
    const fixture = await reservationFixture("installed-result-status-replay", Date.now, (nativeOrigin) => {
      const transport = createNodeNativeGitAdmissionHttpClient();
      return { async request(input) {
        const response = await transport.request({ ...input, endpoint: nativeOrigin });
        if (input.path.endsWith("/statuses")) {
          sent.push(input.body ?? "");
          statusResponses.push(response.statusCode);
          if (loseReply) {
            loseReply = false;
            throw new Error("simulated lost status response");
          }
        }
        return response;
      } };
    });
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "302");
    const request = resultRequest(active.claim, active.issuance, "502");
    enqueueAdditionalDemand(fixture.database);

    // When
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request)).status).toBe(202);
    await waitFor(() => sent.length === 1);
    const currentProof = await post(fixture.origin,
      `/v1/projects/project-a/repositories/root/native-root-ci-result-proof/current-result`, queryAuthorization(),
      { schemaVersion: 1, requestId: randomUUID(), generationId: request.generationId,
        terminalEvent: request.terminalEvent });
    expect(currentProof.status).toBe(200);
    expect(statusResponses).toEqual([201]);
    const statusPath = statusRecordPath(fixture.nativeRoot, request.terminalEvent.payload.reviewId);
    const statusBytes = await readFile(statusPath, "utf8");
    expect(deliveryState(fixture.database).state).toBe("pending");
    const renewal = await post(fixture.origin, "/v1/host-claim-renewals", hostAuthorization("host-a"), {
      schemaVersion: 1, requestId: randomUUID(), generationId: request.generationId,
      hostId: active.claim.hostId, capacity: active.claim.capacity, claimId: active.claim.claimId,
      attemptId: active.issuance.attemptId, descriptorDigest: active.issuance.descriptorDigest
    });
    const restarted = await fixture.restart({ activate: false });
    fixtures.push(restarted);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent).toHaveLength(1);
    expect(deliveryState(restarted.database)).toMatchObject({
      state: "pending", claim: "reported", receipt: "reported", demand: "reported"
    });
    await restarted.activate();
    await waitFor(() => deliveryState(restarted.database).state === "delivered");

    // Then
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(await readFile(statusPath, "utf8")).toBe(statusBytes);
    const delivery = deliveryState(restarted.database);
    expect(JSON.parse(delivery.acknowledgementJson ?? "null")).toEqual(JSON.parse(statusBytes));
    expect(renewal.status).toBe(409);
    expect(delivery).toMatchObject({ state: "delivered", claim: "released", receipt: "released", demand: "completed" });
    const nextClaim = await post(restarted.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest(randomUUID(), "host-a", "primary"));
    expect(nextClaim.status).toBe(201);
    expect(await readdir(join(rootRepository(fixture.nativeRoot), "dim-authoritative-attempts", "ordinary-sysbox",
      "revocations"))).toEqual([]);
    const recovery = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), {
      schemaVersion: 1, requestId: randomUUID(), generationId: request.generationId,
      hostId: active.claim.hostId, capacity: active.claim.capacity, claimId: active.claim.claimId,
      attemptId: active.issuance.attemptId, descriptorDigest: active.issuance.descriptorDigest,
      claim: active.claim, issuance: active.issuance, resourceId: active.claim.claimId, cleanupComplete: true
    });
    expect(recovery.status).toBe(409);
    const database = new DatabaseSync(restarted.database);
    database.prepare("UPDATE native_root_ci_report_outbox SET acknowledgement_digest = ?")
      .run(`sha256:${"9".repeat(64)}`);
    database.close();
    const corruptRows = resultRows(restarted.database);
    await expect(restarted.restart()).rejects.toThrow(/receipt state is invalid/i);
    expect(resultRows(restarted.database)).toEqual(corruptRows);
  }, 30_000);

  it("rejects invalid authority and terminal bindings without recording success", async () => {
    // Given
    let now = 1_000;
    const fixture = await reservationFixture("installed-host-result-rejections", () => now);
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "311");
    const request = resultRequest(active.claim, active.issuance, "511");

    // When
    const foreign = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-b"), request);
    const wrongRole = await post(fixture.origin, "/v1/host-results", queryAuthorization(), request);
    const unclean = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"),
      { ...request, cleanupComplete: false });
    const obsoleteRequest = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"),
      { ...request, schemaVersion: 1 });
    const foreignResource = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"),
      { ...request, resourceId: "70000000-0000-4000-8000-000000000511" });
    const staleGeneration = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"),
      { ...request, generationId: "f".repeat(64) });
    const wrongKind = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), {
      ...request, terminalEvent: { ...request.terminalEvent, eventType: "dim.ci.job.started" }
    });
    const wrongExecutionKind = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), {
      ...request, terminalEvent: { ...request.terminalEvent,
        payload: { ...request.terminalEvent.payload, executionKind: "qemu" } }
    });
    const obsolete = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), {
      ...request, terminalEvent: { ...request.terminalEvent, schemaVersion: 2 }
    });
    const wrongAttempt = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), {
      ...request, terminalEvent: { ...request.terminalEvent, payload: {
        ...request.terminalEvent.payload, attemptId: randomUUID()
      } }
    });
    const wrongDigest = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), {
      ...request, terminalEvent: { ...request.terminalEvent, payload: {
        ...request.terminalEvent.payload, descriptorDigest: `sha256:${"9".repeat(64)}`
      } }
    });
    now = active.leaseExpiresAt + 1;
    const expired = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request);

    // Then
    expect([foreign.status, wrongRole.status, unclean.status, obsoleteRequest.status, foreignResource.status,
      staleGeneration.status,
      wrongKind.status, wrongExecutionKind.status, obsolete.status, wrongAttempt.status, wrongDigest.status, expired.status])
      .toEqual([404, 403, 400, 400, 400, 409, 400, 400, 400, 409, 400, 409]);
    expect(resultRows(fixture.database)).toMatchObject({ results: [], outbox: [], demand: "active",
      claim: "active", receipt: "active" });
  }, 20_000);

  it("rolls back the result when pending outbox insertion fails", async () => {
    // Given
    const fixture = await reservationFixture("installed-host-result-rollback");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "321");
    const request = resultRequest(active.claim, active.issuance, "521");
    const database = new DatabaseSync(fixture.database);
    database.exec(`CREATE TRIGGER fail_result_outbox BEFORE INSERT ON native_root_ci_report_outbox
      BEGIN SELECT RAISE(FAIL, 'injected outbox failure'); END`);
    database.close();

    // When
    const failed = await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request);

    // Then
    expect(failed.status).toBe(500);
    expect(resultRows(fixture.database)).toMatchObject({ results: [], outbox: [], demand: "active",
      claim: "active", receipt: "active" });
  }, 20_000);
});

function deliveryState(file: string): {
  readonly state: string;
  readonly acknowledgementJson: string | undefined;
  readonly claim: string;
  readonly receipt: string;
  readonly demand: string;
} {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const outbox = database.prepare("SELECT state, acknowledgement_json FROM native_root_ci_report_outbox").get();
    return {
      state: String(outbox?.state),
      acknowledgementJson: typeof outbox?.acknowledgement_json === "string" ? outbox.acknowledgement_json : undefined,
      claim: String(database.prepare("SELECT state FROM native_root_ci_claims").get()?.state),
      receipt: String(database.prepare("SELECT state FROM native_root_ci_claim_receipts").get()?.state),
      demand: String(database.prepare("SELECT state FROM native_root_ci_demands").get()?.state)
    };
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
