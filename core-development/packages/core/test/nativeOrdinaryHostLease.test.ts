import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { jsonRecord, post, type AuthorityFixture } from "./nativeOrdinaryAuthorityFixture.js";
import {
  claimRequest,
  leaseIssuer,
  preparedLeaseFixture,
  renewalRequest
} from "./nativeOrdinaryLeaseFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary host claim renewal", () => {
  it("extends only the authenticated exact active tuple and fences it after expiry", async () => {
    // Given
    let now = 1_000;
    const issuer = leaseIssuer();
    const { fixture, claim } = await preparedLeaseFixture(issuer, { now: () => now });
    fixtures.push(fixture);
    now = 2_000;
    const exact = renewalRequest(claim, "30000000-0000-4000-8000-000000000031");

    // When
    const wrongHost = await post(fixture.endpoint, "/v1/host-claim-renewals", "host-b", exact);
    const wrongRole = await post(fixture.endpoint, "/v1/host-claim-renewals", "query", exact);
    const invalid = await fetch(`${fixture.endpoint}/v1/host-claim-renewals`, {
      method: "POST",
      headers: { Authorization: "Basic invalid", "Content-Type": "application/json" },
      body: JSON.stringify(exact)
    });
    const wrongAttempt = await post(fixture.endpoint, "/v1/host-claim-renewals", "host-a", {
      ...exact,
      attemptId: "10000000-0000-4000-8000-000000000099"
    });
    const renewed = await post(fixture.endpoint, "/v1/host-claim-renewals", "host-a", exact);
    now = 2_100;
    const replay = await post(fixture.endpoint, "/v1/host-claim-renewals", "host-a", exact);

    // Then
    expect(wrongHost.status).toBe(404);
    expect([wrongRole.status, invalid.status]).toEqual([403, 401]);
    expect(wrongAttempt.status).toBe(409);
    expect(renewed.status).toBe(200);
    expect(replay.status).toBe(200);
    const renewal = await jsonRecord(renewed);
    expect(renewal).toMatchObject({
      schemaVersion: 1,
      serviceId: "ordinary-main",
      requestId: exact.requestId,
      claimId: claim.claimId,
      leaseExpiresAt: 62_000,
      leaseDurationMilliseconds: 60_000
    });
    expect(await jsonRecord(replay)).toMatchObject({
      requestId: exact.requestId,
      claimId: claim.claimId,
      leaseExpiresAt: 62_000,
      leaseDurationMilliseconds: 59_900
    });
    expect(claimState(fixture.database)).toEqual({ expiresAt: 62_000, state: "active", fence: undefined, assignments: 1 });

    // When
    now = 62_001;
    const verification = await post(fixture.endpoint, "/v1/current-attempt-verifications", "query", {
      schemaVersion: 1,
      requestId: "30000000-0000-4000-8000-000000000033",
      reviewId: claim.reviewId,
      attemptId: claim.attemptId,
      descriptorDigest: claim.descriptorDigest,
      admissionGeneration: claim.admissionGeneration,
      hostId: claim.hostId,
      capacity: claim.capacity
    });
    const denied = await post(fixture.endpoint, "/v1/host-claim-renewals", "host-a", {
      ...exact,
      requestId: "30000000-0000-4000-8000-000000000032"
    });
    const replacement = await post(fixture.endpoint, "/v1/host-claims", "host-a", claimRequest(
      "20000000-0000-4000-8000-000000000032"
    ));

    // Then
    expect(verification.status).toBe(404);
    expect(denied.status).toBe(409);
    expect(replacement.status).toBe(409);
    expect(claimState(fixture.database)).toEqual({ expiresAt: 62_000, state: "recovering", fence: "lease-lost", assignments: 0 });
  });
});

function claimState(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const claim = database.prepare("SELECT lease_expires_at, state FROM claims").get();
    return {
      expiresAt: claim?.lease_expires_at,
      state: claim?.state,
      fence: database.prepare("SELECT reason FROM capacity_fences").get()?.reason,
      assignments: Number(database.prepare("SELECT count(*) total FROM native_attempt_assignments").get()?.total)
    };
  } finally {
    database.close();
  }
}
