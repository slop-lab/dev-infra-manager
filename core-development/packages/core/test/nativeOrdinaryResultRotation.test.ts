import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { admission, jsonRecord, post, type AuthorityFixture } from "./nativeOrdinaryAuthorityFixture.js";
import { leaseIssuer, preparedLeaseFixture } from "./nativeOrdinaryLeaseFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary result generation rotation", () => {
  it("denies and releases a cleaned result when its admission generation is revoked", async () => {
    // Given
    const { fixture, claim } = await preparedLeaseFixture(leaseIssuer());
    fixtures.push(fixture);
    expect((await post(fixture.endpoint, "/v1/host-results", "host-a", resultRequest(claim))).status).toBe(202);

    // When
    const revoked = await post(fixture.endpoint, "/v1/operator-admission-revocations", "registrar", {
      schemaVersion: 1,
      projectId: "project-a",
      repositoryId: "source",
      admissionGeneration: claim.admissionGeneration
    });
    const verification = await post(fixture.endpoint, "/v1/current-attempt-verifications", "query", {
      schemaVersion: 1,
      requestId: "30000000-0000-4000-8000-000000000071",
      reviewId: claim.reviewId,
      attemptId: claim.attemptId,
      descriptorDigest: claim.descriptorDigest,
      admissionGeneration: claim.admissionGeneration,
      hostId: claim.hostId,
      capacity: claim.capacity
    });
    const nextPolicy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(nextPolicy);
    const nextAdmission = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", nextPolicy);

    // Then
    expect(revoked.status).toBe(204);
    expect(verification.status).toBe(404);
    expect(nextAdmission.status).toBe(200);
    expect((await jsonRecord(nextAdmission)).admissionGeneration).not.toBe(claim.admissionGeneration);
    expect(states(fixture.database)).toEqual({ outbox: "denied", denial: "admission-inactive", demand: "failed", claim: "released" });
  });
});

function resultRequest(claim: Readonly<Record<string, unknown>>) {
  const now = "2026-10-05T00:00:00.000Z";
  return {
    schemaVersion: 1,
    requestId: "50000000-0000-4000-8000-000000000071",
    claimId: claim.claimId,
    terminalEvent: {
      schemaVersion: 2,
      eventId: "60000000-0000-4000-8000-000000000071",
      occurredAt: now,
      eventType: "dim.ci.job.completed",
      payload: {
        reviewId: claim.reviewId,
        attemptId: claim.attemptId,
        attempt: 1,
        descriptor: claim.descriptor,
        descriptorDigest: claim.descriptorDigest,
        hostId: claim.hostId,
        capacity: claim.capacity,
        startedAt: now,
        finishedAt: now,
        result: "success",
        completion: { kind: "exited", exitCode: 0 },
        stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
        stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false }
      }
    },
    cleanupComplete: true
  } as const;
}

function states(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const outbox = database.prepare("SELECT state, denial_code FROM report_outbox").get();
    return {
      outbox: outbox?.state,
      denial: outbox?.denial_code,
      demand: database.prepare("SELECT state FROM demands").get()?.state,
      claim: database.prepare("SELECT state FROM claims").get()?.state
    };
  } finally {
    database.close();
  }
}
