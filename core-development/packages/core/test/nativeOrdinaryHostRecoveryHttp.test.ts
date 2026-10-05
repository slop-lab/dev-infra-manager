import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  admission,
  jsonRecord,
  nativeEvent,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";
import {
  leaseIssuer,
  preparedLeaseFixture,
  recoveryRequest
} from "./nativeOrdinaryLeaseFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary host recovery HTTP", () => {
  it("keeps the fence through uncertain revocation and releases only after exact same-host retry", async () => {
    // Given
    let now = 1_000;
    const issuer = leaseIssuer();
    const { fixture, claim } = await preparedLeaseFixture(issuer, { now: () => now });
    fixtures.push(fixture);
    now = 61_001;
    const exact = recoveryRequest(claim, "30000000-0000-4000-8000-000000000041");
    issuer.failNextRevocation();

    // When
    const wrongHost = await post(fixture.endpoint, "/v1/host-recoveries", "host-b", exact);
    const wrongCapacity = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", {
      ...exact,
      capacity: "missing"
    });
    const fakeCleanup = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", {
      ...exact,
      resourceId: "50000000-0000-4000-8000-000000000041"
    });
    const incompleteCleanup = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", {
      ...exact,
      cleanupComplete: false
    });
    const callerSelectedNative = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", {
      ...exact,
      nativeGitUrl: "http://attacker.invalid"
    });
    const uncertain = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", exact);

    // Then
    expect([wrongHost.status, wrongCapacity.status, fakeCleanup.status]).toEqual([404, 404, 409]);
    expect([incompleteCleanup.status, callerSelectedNative.status]).toEqual([400, 400]);
    expect(uncertain.status).toBe(503);
    expect(issuer.revocationObservedUnlocked()).toBe(true);
    expect(recoveryState(fixture.database)).toEqual({
      receipt: "recovering",
      claim: "recovering",
      demand: "claimed",
      cleanupRequestId: exact.requestId,
      revoked: false,
      fenced: true
    });

    // When
    const recovered = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", exact);
    const replay = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", exact);

    // Then
    expect([recovered.status, replay.status]).toEqual([204, 204]);
    expect(issuer.revocations()).toBe(2);
    expect(recoveryState(fixture.database)).toEqual({
      receipt: "released",
      claim: "released",
      demand: "superseded",
      cleanupRequestId: exact.requestId,
      revoked: true,
      fenced: false
    });

    // When
    const nextEvent = {
      ...nativeEvent("00000000-0000-4000-8000-000000000041"),
      reviewId: "b".repeat(64)
    };
    fixture.source.authorizeEvent(nextEvent);
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", nextEvent)).status).toBe(202);
    const fresh = await post(fixture.endpoint, "/v1/host-claims", "host-a", {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000041",
      hostId: "host-a",
      capacity: "primary"
    });

    // Then
    expect(fresh.status).toBe(200);
    expect((await jsonRecord(fresh)).admissionGeneration).toBe(claim.admissionGeneration);
  });

  it("rejects the stale epoch and recovers a restart-fenced claim through the current service", async () => {
    // Given
    const issuer = leaseIssuer();
    const { fixture, claim } = await preparedLeaseFixture(issuer);
    fixtures.push(fixture);
    const restarted = await startAuthority({ database: fixture.database, attemptIssuerClient: issuer });
    issuer.authorizeWith(restarted);
    fixtures.push(restarted);
    const request = recoveryRequest(claim, "30000000-0000-4000-8000-000000000042");

    // When
    const stale = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", request);
    const response = await post(restarted.endpoint, "/v1/host-recoveries", "host-a", request);
    const replay = await post(restarted.endpoint, "/v1/host-recoveries", "host-a", request);

    // Then
    expect([stale.status, response.status, replay.status]).toEqual([503, 204, 204]);
    expect(recoveryState(restarted.database)).toMatchObject({
      receipt: "released",
      claim: "released",
      demand: "superseded",
      revoked: true,
      fenced: false
    });
  });

  it("releases a rotated-generation fence without reviving old demand", async () => {
    // Given
    const issuer = leaseIssuer();
    const { fixture, claim } = await preparedLeaseFixture(issuer);
    fixtures.push(fixture);
    const rotatedPolicy = admission("project-a", "source", "2");
    fixture.source.authorizePolicy(rotatedPolicy);
    const rotation = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", rotatedPolicy);
    const currentGeneration = (await jsonRecord(rotation)).admissionGeneration;
    const request = recoveryRequest(claim, "30000000-0000-4000-8000-000000000043");

    // When
    const recovered = await post(fixture.endpoint, "/v1/host-recoveries", "host-a", request);
    const currentEvent = {
      ...nativeEvent("00000000-0000-4000-8000-000000000043"),
      reviewId: "c".repeat(64),
      policyRevision: "policy-2",
      requiredReviewRevision: "review-2",
      requiredJobSetRevision: "jobs-2"
    };
    fixture.source.authorizeEvent(currentEvent);
    await post(fixture.endpoint, "/v1/native-events", "webhook", currentEvent);
    const fresh = await post(fixture.endpoint, "/v1/host-claims", "host-a", {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000043",
      hostId: "host-a",
      capacity: "primary"
    });

    // Then
    expect(recovered.status).toBe(204);
    expect(fresh.status).toBe(200);
    const freshClaim = await jsonRecord(fresh);
    expect(freshClaim.admissionGeneration).toBe(currentGeneration);
    expect(freshClaim.admissionGeneration).not.toBe(claim.admissionGeneration);
  });
});

function recoveryState(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const claim = database.prepare(`
      SELECT state, recovery_request_id, native_revocation_json FROM claims
    `).get();
    return {
      receipt: database.prepare("SELECT state FROM claim_receipts").get()?.state,
      claim: claim?.state,
      demand: database.prepare("SELECT state FROM demands").get()?.state,
      cleanupRequestId: claim?.recovery_request_id,
      revoked: typeof claim?.native_revocation_json === "string",
      fenced: database.prepare("SELECT 1 present FROM capacity_fences").get()?.present === 1
    };
  } finally {
    database.close();
  }
}
