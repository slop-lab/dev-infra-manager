import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { NativeGitResultReporterUnavailableError } from "../../../../core/packages/core/src/nativeGitResultReporter.js";
import { jsonRecord, post, startAuthority, type AuthorityFixture } from "./nativeOrdinaryAuthorityFixture.js";
import { leaseIssuer, preparedLeaseFixture } from "./nativeOrdinaryLeaseFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary host results", () => {
  it("commits cleanup and the terminal report before acknowledging the host", async () => {
    // Given
    const { fixture, claim } = await preparedLeaseFixture(leaseIssuer());
    fixtures.push(fixture);
    const request = resultRequest(claim);

    // When
    const response = await post(fixture.endpoint, "/v1/host-results", "host-a", request);

    // Then
    expect(response.status).toBe(202);
    expect(await jsonRecord(response)).toEqual({
      schemaVersion: 1,
      claimId: claim.claimId,
      accepted: true
    });
    expect(resultState(fixture.database)).toEqual({
      results: 1,
      outbox: "pending",
      claim: "reported",
      receipt: "reported",
      demand: "reported"
    });
  });

  it("replays an identical result and rejects changed reuse without replacing durable bytes", async () => {
    // Given
    const { fixture, claim } = await preparedLeaseFixture(leaseIssuer());
    fixtures.push(fixture);
    const request = resultRequest(claim);

    // When
    const first = await post(fixture.endpoint, "/v1/host-results", "host-a", request);
    const replay = await post(fixture.endpoint, "/v1/host-results", "host-a", request);
    const collision = await post(fixture.endpoint, "/v1/host-results", "host-a", {
      ...request,
      terminalEvent: { ...request.terminalEvent, eventId: "60000000-0000-4000-8000-000000000002" }
    });

    // Then
    expect([first.status, replay.status, collision.status]).toEqual([202, 202, 409]);
    expect(resultState(fixture.database)).toMatchObject({ results: 1, outbox: "pending" });
  });

  it("rejects foreign, inconsistent, unclean, and expired results without durable result mutation", async () => {
    // Given
    let now = 1_000;
    const { fixture, claim } = await preparedLeaseFixture(leaseIssuer(), { now: () => now });
    fixtures.push(fixture);
    const request = resultRequest(claim);

    // When
    const foreign = await post(fixture.endpoint, "/v1/host-results", "host-b", request);
    const wrongAttempt = await post(fixture.endpoint, "/v1/host-results", "host-a", {
      ...request,
      terminalEvent: {
        ...request.terminalEvent,
        payload: { ...request.terminalEvent.payload, attemptId: "10000000-0000-4000-8000-000000000099" }
      }
    });
    const inconsistent = await post(fixture.endpoint, "/v1/host-results", "host-a", {
      ...request,
      terminalEvent: {
        ...request.terminalEvent,
        payload: { ...request.terminalEvent.payload, completion: { kind: "exited", exitCode: 1 } }
      }
    });
    const wrongGeneration = await post(fixture.endpoint, "/v1/host-results", "host-a", {
      ...request,
      terminalEvent: {
        ...request.terminalEvent,
        payload: {
          ...request.terminalEvent.payload,
          descriptor: { ...request.terminalEvent.payload.descriptor, admissionGeneration: "foreign-generation" }
        }
      }
    });
    const wrongDescriptor = await post(fixture.endpoint, "/v1/host-results", "host-a", {
      ...request,
      terminalEvent: {
        ...request.terminalEvent,
        payload: {
          ...request.terminalEvent.payload,
          descriptor: { ...request.terminalEvent.payload.descriptor, candidateCommit: "9".repeat(40) }
        }
      }
    });
    const truncatedSuccess = await post(fixture.endpoint, "/v1/host-results", "host-a", {
      ...request,
      terminalEvent: {
        ...request.terminalEvent,
        payload: {
          ...request.terminalEvent.payload,
          stdout: { ...request.terminalEvent.payload.stdout, truncated: true }
        }
      }
    });
    const unclean = await post(fixture.endpoint, "/v1/host-results", "host-a", { ...request, cleanupComplete: false });
    now = 61_001;
    const expired = await post(fixture.endpoint, "/v1/host-results", "host-a", request);

    // Then
    expect([
      foreign.status, wrongAttempt.status, inconsistent.status, wrongGeneration.status,
      wrongDescriptor.status, truncatedSuccess.status, unclean.status, expired.status
    ]).toEqual([404, 409, 400, 400, 400, 400, 400, 409]);
    expect(resultState(fixture.database).results).toBe(0);
  });

  it("retries byte-identical native delivery after response loss and restart, then releases capacity", async () => {
    // Given
    let now = 1_000;
    const sent: string[] = [];
    const unavailable = {
      async send(eventJson: string): Promise<"acknowledged"> {
        sent.push(eventJson);
        throw new NativeGitResultReporterUnavailableError();
      }
    };
    const { fixture, claim } = await preparedLeaseFixture(leaseIssuer(), {
      now: () => now,
      resultReporterClient: unavailable
    });
    fixtures.push(fixture);
    const request = resultRequest(claim);
    expect((await post(fixture.endpoint, "/v1/host-results", "host-a", request)).status).toBe(202);
    await waitFor(() => sent.length === 1);
    await fixture.close();
    now = 2_000;
    const restarted = await startRestarted(fixture, () => now, sent);
    fixtures.push(restarted);

    // When
    await waitFor(() => resultState(restarted.database).demand === "completed");
    const verification = await post(restarted.endpoint, "/v1/current-attempt-verifications", "query", {
      schemaVersion: 1,
      requestId: "30000000-0000-4000-8000-000000000041",
      reviewId: claim.reviewId,
      attemptId: claim.attemptId,
      descriptorDigest: claim.descriptorDigest,
      admissionGeneration: claim.admissionGeneration,
      hostId: claim.hostId,
      capacity: claim.capacity
    });
    const next = await post(restarted.endpoint, "/v1/host-claims", "host-a", {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000041",
      hostId: "host-a",
      capacity: "primary"
    });

    // Then
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(verification.status).toBe(200);
    expect(next.status).toBe(204);
    expect(resultState(restarted.database)).toMatchObject({ outbox: "delivered", claim: "released", receipt: "released" });
  });

  it("records terminal native denial as failed evidence before releasing cleaned capacity", async () => {
    // Given
    const { fixture, claim } = await preparedLeaseFixture(leaseIssuer(), {
      resultReporterClient: {
        async send() {
          return "denied";
        }
      }
    });
    fixtures.push(fixture);

    // When
    const response = await post(fixture.endpoint, "/v1/host-results", "host-a", resultRequest(claim));
    await waitFor(() => resultState(fixture.database).demand === "failed");

    // Then
    expect(response.status).toBe(202);
    expect(resultState(fixture.database)).toMatchObject({
      results: 1,
      outbox: "denied",
      claim: "released",
      receipt: "released",
      demand: "failed"
    });
  });
});

function resultRequest(claim: Readonly<Record<string, unknown>>) {
  const descriptor = claim.descriptor;
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
    throw new TypeError("claim descriptor is missing");
  }
  const now = "2026-10-05T00:00:00.000Z";
  return {
    schemaVersion: 1,
    requestId: "50000000-0000-4000-8000-000000000001",
    claimId: claim.claimId,
    terminalEvent: {
      schemaVersion: 2,
      eventId: "60000000-0000-4000-8000-000000000001",
      occurredAt: now,
      eventType: "dim.ci.job.completed",
      payload: {
        reviewId: claim.reviewId,
        attemptId: claim.attemptId,
        attempt: 1,
        descriptor,
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

function resultState(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      results: Number(database.prepare("SELECT count(*) total FROM host_results").get()?.total),
      outbox: database.prepare("SELECT state FROM report_outbox").get()?.state,
      claim: database.prepare("SELECT state FROM claims").get()?.state,
      receipt: database.prepare("SELECT state FROM claim_receipts WHERE state <> 'empty'").get()?.state,
      demand: database.prepare("SELECT state FROM demands").get()?.state
    };
  } finally {
    database.close();
  }
}

async function startRestarted(
  fixture: AuthorityFixture,
  now: () => number,
  sent: string[]
): Promise<AuthorityFixture> {
  return startAuthority({
    database: fixture.database,
    now,
    resultReporterClient: {
      async send(eventJson) {
        sent.push(eventJson);
        return "acknowledged";
      }
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
