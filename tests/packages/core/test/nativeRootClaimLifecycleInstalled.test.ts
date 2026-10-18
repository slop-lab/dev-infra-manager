import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeGitAttemptIssuerClient,
  type NativeGitAttemptIssuerHttpClient
} from "../../../../core/packages/managed/src/nativeGitAttemptIssuerClient.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/managed/src/nativeGitAdmissionSource.js";
import { parseNativeRootCiClaim, type NativeRootCiClaim } from "../../../../core/packages/managed/src/nativeRootCiClaimProtocol.js";
import type { NativeJobAttemptIssuance } from "../../../../core/packages/managed/src/nativeGitAttemptIssuerModel.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import {
  claimRequest,
  hostAuthorization,
  post,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, resultRequest } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];
const attemptIssuer = { username: "ordinary-attempts", password: bundleSecrets.attemptIssuer } as const;

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native root claim lifecycle", () => {
  it("activates one verified current attempt and renews only its exact assignment", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-activation");
    fixtures.push(fixture);
    const claim = await reserve(fixture, "20000000-0000-4000-8000-000000000301");
    const issuance = await issue(fixture, claim);
    const request = activationRequest(claim, issuance, "30000000-0000-4000-8000-000000000301");
    const database = new DatabaseSync(fixture.database);
    const admission = database.prepare("SELECT lease_expires_at FROM native_root_admissions WHERE admission_generation = ?")
      .get(fixture.admissionGeneration);
    if (admission === undefined || typeof admission.lease_expires_at !== "number") {
      throw new TypeError("admission expiry is unavailable");
    }
    database.prepare("UPDATE native_root_admissions SET lease_expires_at = 1 WHERE admission_generation = ?")
      .run(fixture.admissionGeneration);

    // When
    const staleAdmission = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"), request);
    database.prepare("UPDATE native_root_admissions SET lease_expires_at = ? WHERE admission_generation = ?")
      .run(admission.lease_expires_at, fixture.admissionGeneration);
    database.close();
    const wrongHost = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-b"), request);
    const wrongGeneration = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"), {
      ...request, generationId: "f".repeat(64)
    });
    const wrongEpoch = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"), {
      ...request, claim: { ...claim, serviceEpochId: randomUUID() }
    });
    const wrongDescriptor = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"), {
      ...request, issuance: { ...issuance, descriptorDigest: `sha256:${"9".repeat(64)}` }
    });
    const activated = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"), request);
    const replay = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"), request);
    const duplicate = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"), {
      ...request, requestId: "30000000-0000-4000-8000-000000000302"
    });
    const renewal = renewalRequest(claim, issuance, "40000000-0000-4000-8000-000000000301");
    const wrongRenewal = await post(fixture.origin, "/v1/host-claim-renewals", hostAuthorization("host-a"), {
      ...renewal, descriptorDigest: `sha256:${"8".repeat(64)}`
    });
    const renewed = await post(fixture.origin, "/v1/host-claim-renewals", hostAuthorization("host-a"), renewal);

    // Then
    expect([staleAdmission.status, wrongHost.status, wrongGeneration.status, wrongEpoch.status,
      wrongDescriptor.status]).toEqual([409, 404, 409, 409, 409]);
    expect([activated.status, replay.status, duplicate.status]).toEqual([201, 200, 409]);
    expect(replay.body).toEqual(activated.body);
    expect([wrongRenewal.status, renewed.status]).toEqual([409, 200]);
    expect(lifecycleRows(fixture.database)).toMatchObject({
      demand: { state: "active" },
      claim: { state: "active" },
      receipt: { state: "active", attempt_id: issuance.attemptId, assignment_json: expect.any(String) }
    });
  }, 20_000);

  it("keeps restart capacity fenced until exact same-host cleanup revokes uncertain issuance", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-recovery");
    fixtures.push(fixture);
    const claim = await reserve(fixture, "20000000-0000-4000-8000-000000000311");
    const transport = createNodeNativeGitAdmissionHttpClient();
    const issueBodies: string[] = [];
    let loseResponse = true;
    const client = issuerClient(fixture, async (input) => {
      const response = await transport.request({ ...input, endpoint: fixture.nativeOrigin });
      if (!input.path.endsWith("/job-attempts")) return response;
      issueBodies.push(input.body ?? "");
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after native persistence");
      }
      return response;
    });
    const descriptor = await client.loadDescriptor({ claim });
    await expect(client.issueAttempt({ context: { claim }, descriptor })).rejects.toThrow(/unavailable/);
    const restarted = await fixture.restart();
    fixtures.push(restarted);
    const issuance = (await client.issueAttempt({ context: { claim }, descriptor })).issuance;
    const request = recoveryRequest(claim, issuance, "50000000-0000-4000-8000-000000000311");

    // When
    const fenced = await post(restarted.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest("20000000-0000-4000-8000-000000000312", "host-a", "primary"));
    const foreign = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-b"), request);
    const wrongGeneration = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), {
      ...request, generationId: "f".repeat(64)
    });
    const wrongEpoch = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), {
      ...request, claim: { ...claim, serviceEpochId: randomUUID() }
    });
    const wrongDescriptor = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), {
      ...request, issuance: { ...issuance, descriptorDigest: `sha256:${"7".repeat(64)}` }
    });
    const incomplete = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), {
      ...request, cleanupComplete: false
    });
    const stillFenced = await post(restarted.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest("20000000-0000-4000-8000-000000000313", "host-a", "primary"));
    const recovered = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), request);
    const replay = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), request);

    // Then
    expect(fenced.status).toBe(409);
    expect([foreign.status, wrongGeneration.status, wrongEpoch.status, wrongDescriptor.status, incomplete.status])
      .toEqual([404, 409, 409, 400, 400]);
    expect(stillFenced.status).toBe(409);
    expect([recovered.status, replay.status]).toEqual([204, 204]);
    expect(issueBodies).toHaveLength(2);
    expect(new Set(issueBodies).size).toBe(1);
    expect(lifecycleRows(restarted.database)).toMatchObject({
      demand: { state: "superseded" },
      claim: { state: "released" },
      receipt: { state: "released", recovery_request_id: request.requestId, revocation_json: expect.any(String) }
    });
  }, 20_000);

  it("refuses to renew an active attempt after the protected root moves in the same admission", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-root-drift");
    fixtures.push(fixture);
    const claim = await reserve(fixture, "20000000-0000-4000-8000-000000000321");
    const issuance = await issue(fixture, claim);
    const activation = await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"),
      activationRequest(claim, issuance, "30000000-0000-4000-8000-000000000321"));
    expect(activation.status).toBe(201);
    const database = new DatabaseSync(fixture.database);
    database.prepare(`UPDATE native_root_admissions SET root_sequence = root_sequence + 1,
      root_commit = ?, root_tree = ? WHERE admission_generation = ?`).run(
        "6".repeat(40), "7".repeat(40), fixture.admissionGeneration);
    database.close();

    // When
    const renewal = await post(fixture.origin, "/v1/host-claim-renewals", hostAuthorization("host-a"),
      renewalRequest(claim, issuance, "40000000-0000-4000-8000-000000000321"));

    // Then
    expect(renewal.status).toBe(409);
  }, 20_000);

  it("renews an exact active execution after only its intake eligibility cache expires", async () => {
    // Given
    const fixture = await reservationFixture("installed-active-cache-expiry");
    fixtures.push(fixture);
    const claim = await reserve(fixture, "20000000-0000-4000-8000-000000000325");
    const issuance = await issue(fixture, claim);
    expect((await post(fixture.origin, "/v1/host-claim-activations", hostAuthorization("host-a"),
      activationRequest(claim, issuance, "30000000-0000-4000-8000-000000000325"))).status).toBe(201);
    const database = new DatabaseSync(fixture.database);
    database.prepare("UPDATE native_root_admissions SET lease_expires_at = 1 WHERE admission_generation = ?")
      .run(fixture.admissionGeneration);
    database.close();

    // When
    const renewed = await post(fixture.origin, "/v1/host-claim-renewals", hostAuthorization("host-a"),
      renewalRequest(claim, issuance, "40000000-0000-4000-8000-000000000325"));

    // Then
    expect(renewed.status).toBe(200);
    expect(lifecycleRows(fixture.database)).toMatchObject({ demand: { state: "active" },
      claim: { state: "active" }, receipt: { state: "active" } });
  }, 20_000);

  it("revokes and denies a reported pending result before releasing its capacity", async () => {
    // Given
    const fixture = await reservationFixture("installed-reported-result-recovery");
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "331");
    const result = resultRequest(active.claim, active.issuance, "531");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    const request = recoveryRequest(active.claim, active.issuance, "50000000-0000-4000-8000-000000000331");

    // When
    const recovered = await post(fixture.origin, "/v1/host-recoveries", hostAuthorization("host-a"), request);
    const restarted = await fixture.restart();
    fixtures.push(restarted);
    const replay = await post(restarted.origin, "/v1/host-recoveries", hostAuthorization("host-a"), request);

    // Then
    expect([recovered.status, replay.status]).toEqual([204, 204]);
    expect(lifecycleRows(restarted.database)).toMatchObject({
      demand: { state: "completed" },
      claim: { state: "released" },
      receipt: { state: "released", recovery_request_id: request.requestId, revocation_json: expect.any(String) },
      outbox: { state: "denied" }
    });
  }, 20_000);

  it("lets reported recovery deny an in-flight exact acknowledgement before local release", async () => {
    // Given
    let releaseAcknowledgement: (() => void) | undefined;
    let nativeAccepted: (() => void) | undefined;
    const acknowledgementHeld = new Promise<void>((resolve) => { releaseAcknowledgement = resolve; });
    const acceptedByNative = new Promise<void>((resolve) => { nativeAccepted = resolve; });
    const fixture = await reservationFixture("installed-reported-result-race", Date.now, (nativeOrigin) => {
      const transport = createNodeNativeGitAdmissionHttpClient();
      return { async request(input) {
        const response = await transport.request({ ...input, endpoint: nativeOrigin });
        if (input.path.endsWith("/statuses")) {
          nativeAccepted?.();
          await acknowledgementHeld;
        }
        return response;
      } };
    });
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "332");
    const result = resultRequest(active.claim, active.issuance, "532");
    const recovery = recoveryRequest(active.claim, active.issuance, "50000000-0000-4000-8000-000000000332");

    // When
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    await acceptedByNative;
    const recovered = await post(fixture.origin, "/v1/host-recoveries", hostAuthorization("host-a"), recovery);
    releaseAcknowledgement?.();
    await waitFor(() => lifecycleRows(fixture.database).outbox !== undefined);

    // Then
    expect(recovered.status).toBe(204);
    expect(lifecycleRows(fixture.database)).toMatchObject({ demand: { state: "completed" },
      claim: { state: "released" }, receipt: { state: "released", revocation_json: expect.any(String) },
      outbox: { state: "denied" } });
  }, 30_000);
});

async function reserve(fixture: ReservationFixture, requestId: string): Promise<NativeRootCiClaim> {
  const response = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"),
    claimRequest(requestId, "host-a", "primary"));
  expect(response.status).toBe(201);
  return parseNativeRootCiClaim(response.body);
}

function issuerClient(fixture: ReservationFixture,
  request?: NativeGitAttemptIssuerHttpClient["request"]) {
  const transport = createNodeNativeGitAdmissionHttpClient();
  const httpClient: NativeGitAttemptIssuerHttpClient = {
    request: request ?? ((input) => transport.request({ ...input, endpoint: fixture.nativeOrigin }))
  };
  return createNativeGitAttemptIssuerClient({ config: {
    endpoint: "http://native-git:8080", serviceId: "native-main", attemptIssuer
  }, generationId, httpClient });
}

async function issue(fixture: ReservationFixture, claim: NativeRootCiClaim): Promise<NativeJobAttemptIssuance> {
  const client = issuerClient(fixture);
  const descriptor = await client.loadDescriptor({ claim });
  return (await client.issueAttempt({ context: { claim }, descriptor })).issuance;
}

function activationRequest(claim: NativeRootCiClaim, issuance: NativeJobAttemptIssuance, requestId: string) {
  return { schemaVersion: 1, requestId, generationId, claim, issuance } as const;
}

function renewalRequest(claim: NativeRootCiClaim, issuance: NativeJobAttemptIssuance, requestId: string) {
  return { schemaVersion: 1, requestId, generationId, hostId: claim.hostId, capacity: claim.capacity,
    claimId: claim.claimId, attemptId: issuance.attemptId, descriptorDigest: issuance.descriptorDigest } as const;
}

function recoveryRequest(claim: NativeRootCiClaim, issuance: NativeJobAttemptIssuance, requestId: string) {
  return { ...renewalRequest(claim, issuance, requestId), claim, issuance,
    resourceId: claim.claimId, cleanupComplete: true } as const;
}

function lifecycleRows(file: string): Readonly<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      demand: database.prepare("SELECT state FROM native_root_ci_demands").get(),
      claim: database.prepare("SELECT state FROM native_root_ci_claims").get(),
      receipt: database.prepare(`SELECT state, attempt_id, assignment_json, recovery_request_id,
        revocation_json FROM native_root_ci_claim_receipts`).get(),
      outbox: database.prepare("SELECT state FROM native_root_ci_report_outbox").get()
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
