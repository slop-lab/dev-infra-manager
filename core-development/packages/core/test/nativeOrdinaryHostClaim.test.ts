import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeGitAttemptIssuerClient } from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import {
  admission,
  assignment,
  authorityCredentials,
  descriptor,
  jsonRecord,
  nativeEvent,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary host claims", () => {
  it("activates one receipt-bound attempt across concurrent claims and response retry", async () => {
    // Given
    let issued = 0;
    let issuanceRequestId = "";
    let nativeObservedUnlocked = false;
    let fixture: AuthorityFixture;
    const issuer: NativeGitAttemptIssuerClient = {
      async loadDescriptor(context) {
        const database = new DatabaseSync(fixture.database);
        database.exec("BEGIN IMMEDIATE; ROLLBACK;");
        database.close();
        nativeObservedUnlocked = true;
        const value = descriptor(context.event.projectId, context.event.repositoryId, context.admissionGeneration);
        return { reviewId: context.event.reviewId, descriptor: value, digest: nativeDescriptorDigest(value) };
      },
      async issueAttempt(input) {
        issued += 1;
        issuanceRequestId = input.issuanceRequestId;
        const attemptId = "10000000-0000-4000-8000-000000000009";
        const authorized = assignment(input.descriptor.descriptor, input.context.event.reviewId, attemptId);
        fixture.source.authorizeAttempt(authorized);
        return {
          replayed: issued > 1,
          issuance: {
            schemaVersion: 2,
            issuanceRequestId: input.issuanceRequestId,
            attemptId,
            reviewId: input.context.event.reviewId,
            attempt: 1,
            descriptor: input.descriptor.descriptor,
            descriptorDigest: input.descriptor.digest,
            hostId: input.context.capacity.hostId,
            capacity: input.context.capacity.capacity,
            issuedBy: "ordinary-attempts",
            issuedAt: "2026-10-05T00:00:00.000Z"
          }
        };
      },
      async revokeAttempt() {
        throw new Error("revocation is not expected");
      }
    };
    fixture = await startAuthority({ attemptIssuerClient: issuer });
    fixtures.push(fixture);
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    const admitted = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);
    const generation = (await jsonRecord(admitted)).admissionGeneration;
    if (typeof generation !== "string") throw new Error("admission generation is missing");
    const event = nativeEvent();
    fixture.source.authorizeEvent(event);
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);
    const request = {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000001",
      hostId: "host-a",
      capacity: "primary"
    } as const;

    // When
    const [first, competing] = await Promise.all([
      post(fixture.endpoint, "/v1/host-claims", "host-a", request),
      post(fixture.endpoint, "/v1/host-claims", "host-b", { ...request, requestId: "20000000-0000-4000-8000-000000000002", hostId: "host-b", capacity: "backup" })
    ]);
    const replay = await post(fixture.endpoint, "/v1/host-claims", "host-a", request);
    const firstClaim = await jsonRecord(first);
    const verification = await post(fixture.endpoint, "/v1/current-attempt-verifications", "query", {
      schemaVersion: 1,
      requestId: "30000000-0000-4000-8000-000000000001",
      reviewId: firstClaim.reviewId,
      attemptId: firstClaim.attemptId,
      descriptorDigest: firstClaim.descriptorDigest,
      admissionGeneration: firstClaim.admissionGeneration,
      hostId: firstClaim.hostId,
      capacity: firstClaim.capacity
    });

    // Then
    expect(first.status).toBe(200);
    expect(competing.status).toBe(204);
    expect(replay.status).toBe(200);
    const claim = firstClaim;
    expect(await jsonRecord(replay)).toEqual(claim);
    expect(claim.claimId).toBe(issuanceRequestId);
    expect(claim.admissionGeneration).toBe(generation);
    expect(JSON.stringify(claim)).not.toMatch(/secret|password|token|credential/i);
    expect(issued).toBe(1);
    expect(nativeObservedUnlocked).toBe(true);
    expect(verification.status).toBe(200);
    expect(claimCounts(fixture.database)).toEqual({ receipts: 2, claims: 1, assignments: 1, preparing: 0 });
  });

  it("denies a foreign host body and the removed scheduler route", async () => {
    // Given
    const fixture = await startAuthority();
    fixtures.push(fixture);
    const request = {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000003",
      hostId: "host-b",
      capacity: "backup"
    } as const;

    // When
    const foreign = await post(fixture.endpoint, "/v1/host-claims", "host-a", request);
    const wrongRole = await post(fixture.endpoint, "/v1/host-claims", "query", request);
    const invalid = await fetch(`${fixture.endpoint}/v1/host-claims`, {
      method: "POST",
      headers: { Authorization: "Basic invalid", "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    const scheduler = await fetch(`${fixture.endpoint}/v1/current-attempt-assignments`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${authorityCredentials.query.username}:${authorityCredentials.query.password}`).toString("base64")}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    });

    // Then
    expect(foreign.status).toBe(404);
    expect(wrongRole.status).toBe(403);
    expect(invalid.status).toBe(401);
    expect(scheduler.status).toBe(404);
    expect(claimCounts(fixture.database)).toEqual({ receipts: 0, claims: 0, assignments: 0, preparing: 0 });
  });

  it("revokes a native issuance whose descriptor drifts from the configured runner image", async () => {
    // Given
    let revoked = 0;
    let fixture: AuthorityFixture;
    const issuer: NativeGitAttemptIssuerClient = {
      async loadDescriptor(context) {
        const value = {
          ...descriptor(context.event.projectId, context.event.repositoryId, context.admissionGeneration),
          runnerBaseImage: `registry.example/runner@sha256:${"9".repeat(64)}`
        };
        return { reviewId: context.event.reviewId, descriptor: value, digest: nativeDescriptorDigest(value) };
      },
      async issueAttempt(input) {
        const attemptId = "10000000-0000-4000-8000-000000000029";
        fixture.source.authorizeAttempt(assignment(input.descriptor.descriptor, input.context.event.reviewId, attemptId));
        return {
          replayed: false,
          issuance: {
            schemaVersion: 2, issuanceRequestId: input.issuanceRequestId, attemptId,
            reviewId: input.context.event.reviewId, attempt: 1, descriptor: input.descriptor.descriptor,
            descriptorDigest: input.descriptor.digest, hostId: input.context.capacity.hostId,
            capacity: input.context.capacity.capacity, issuedBy: "ordinary-attempts", issuedAt: "2026-10-05T00:00:00.000Z"
          }
        };
      },
      async revokeAttempt(issuance) {
        revoked += 1;
        return {
          schemaVersion: 2, revocationId: "40000000-0000-4000-8000-000000000029",
          attemptId: issuance.attemptId, reviewId: issuance.reviewId, jobName: issuance.descriptor.jobName,
          attempt: issuance.attempt, descriptorDigest: issuance.descriptorDigest, hostId: issuance.hostId,
          capacity: issuance.capacity, revokedBy: "ordinary-attempts", revokedAt: "2026-10-05T00:00:01.000Z"
        };
      }
    };
    fixture = await startAuthority({ attemptIssuerClient: issuer });
    fixtures.push(fixture);
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    expect((await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy)).status).toBe(200);
    const event = nativeEvent();
    fixture.source.authorizeEvent(event);
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);

    // When
    const response = await post(fixture.endpoint, "/v1/host-claims", "host-a", {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000029",
      hostId: "host-a",
      capacity: "primary"
    });

    // Then
    expect(response.status).toBe(409);
    expect(revoked).toBe(1);
    expect(claimCounts(fixture.database)).toEqual({ receipts: 1, claims: 0, assignments: 0, preparing: 0 });
  });
});

function claimCounts(file: string): Readonly<Record<string, number>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (table: string, predicate = "1") => {
      const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${predicate}`).get();
      if (row === undefined || typeof row.total !== "number") throw new Error("claim count is invalid");
      return row.total;
    };
    return {
      receipts: count("claim_receipts"),
      claims: count("claims"),
      assignments: count("native_attempt_assignments"),
      preparing: count("claim_receipts", "state = 'preparing'")
    };
  } finally {
    database.close();
  }
}
