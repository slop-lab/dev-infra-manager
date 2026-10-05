import { describe, expect, it } from "vitest";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  createNativeOrdinaryHostClient,
  NativeOrdinaryHostClientError
} from "../../../../core/packages/core/src/nativeOrdinaryHostClient.js";
import { execution } from "./nativeOrdinaryExecutorFixture.js";

const config = {
  endpoint: "http://ordinary-ci:8080",
  serviceId: "ordinary-main",
  hostId: "host-a",
  capacity: "primary",
  credential: {
    username: "host-a",
    password: "host-a-token-000000000000000000000000"
  }
} as const;

describe("native ordinary host HTTP client", () => {
  it("authenticates and accepts only an exact host identity and complete claim", async () => {
    // Given
    const claim = {
      ...execution().claim,
      requestId: "10000000-0000-4000-8000-000000000010",
      leaseExpiresAt: Date.now() + 60_000
    };
    const http = new SequenceHttpClient([
      jsonResponse(200, { schemaVersion: 1, serviceId: "ordinary-main", role: "native-host", hostId: "host-a" }),
      jsonResponse(200, claim)
    ]);
    const client = createNativeOrdinaryHostClient(config, http);

    // When
    await client.attest(new AbortController().signal);
    const received = await client.claim(client.prepareClaim(claim.requestId), new AbortController().signal);

    // Then
    expect(received).toEqual(claim);
    expect(http.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/v1/host-identity"],
      ["POST", "/v1/host-claims"]
    ]);
    expect(http.requests[1]?.body).toBe(JSON.stringify({
      schemaVersion: 1,
      requestId: claim.requestId,
      hostId: "host-a",
      capacity: "primary"
    }));
  });

  it.each([
    ["service", { serviceId: "ordinary-foreign" }],
    ["host", { hostId: "host-b" }],
    ["capacity", { capacity: "backup" }],
    ["attempt", { attempt: 0 }],
    ["expiry", { leaseExpiresAt: 0 }],
    ["descriptor digest", { descriptorDigest: `sha256:${"f".repeat(64)}` }]
  ])("rejects a claim with a wrong %s binding", async (_label, change) => {
    // Given
    const requestId = "10000000-0000-4000-8000-000000000011";
    const response = { ...execution().claim, requestId, leaseExpiresAt: Date.now() + 60_000, ...change };
    const client = createNativeOrdinaryHostClient(config, new SequenceHttpClient([jsonResponse(200, response)]));

    // When / Then
    await expect(client.claim(client.prepareClaim(requestId), new AbortController().signal))
      .rejects.toBeInstanceOf(NativeOrdinaryHostClientError);
  });

  it("requires exact renewal, recovery, and result acknowledgements", async () => {
    // Given
    const claim = execution().claim;
    const renewalRequest = {
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000012",
      hostId: claim.hostId,
      capacity: claim.capacity,
      claimId: claim.claimId,
      attemptId: claim.attemptId,
      descriptorDigest: claim.descriptorDigest
    } as const;
    const http = new SequenceHttpClient([
      jsonResponse(200, {
        schemaVersion: 1,
        serviceId: "ordinary-main",
        requestId: renewalRequest.requestId,
        claimId: claim.claimId,
        leaseExpiresAt: Date.now() + 60_000,
        leaseDurationMilliseconds: 60_000
      }),
      emptyResponse(204),
      jsonResponse(202, { schemaVersion: 1, claimId: claim.claimId, accepted: true })
    ]);
    const client = createNativeOrdinaryHostClient(config, http);

    // When
    const renewal = await client.renewClaim(renewalRequest, new AbortController().signal);
    const recovery = client.prepareRecovery({ ...renewalRequest, resourceId: claim.claimId, cleanupComplete: true });
    await client.recoverClaim(recovery, new AbortController().signal);
    const result = client.prepareResult({
      schemaVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000013",
      claimId: claim.claimId,
      terminalEvent: executionTerminalEvent(),
      cleanupComplete: true
    });
    await client.reportResult(result, new AbortController().signal);

    // Then
    expect(renewal.claimId).toBe(claim.claimId);
    expect(http.requests.map((request) => request.path)).toEqual([
      "/v1/host-claim-renewals",
      "/v1/host-recoveries",
      "/v1/host-results"
    ]);
  });
});

class SequenceHttpClient implements NativeGitAdmissionHttpClient {
  readonly requests: NativeGitAdmissionHttpRequest[] = [];
  readonly #responses: NativeGitAdmissionHttpResponse[];

  constructor(responses: readonly NativeGitAdmissionHttpResponse[]) {
    this.#responses = [...responses];
  }

  async request(input: NativeGitAdmissionHttpRequest): Promise<NativeGitAdmissionHttpResponse> {
    this.requests.push(input);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("unexpected HTTP request");
    return response;
  }
}

function jsonResponse(statusCode: number, body: unknown): NativeGitAdmissionHttpResponse {
  return {
    statusCode,
    contentType: "application/json",
    cacheControl: "no-store",
    body: Buffer.from(JSON.stringify(body))
  };
}

function emptyResponse(statusCode: number): NativeGitAdmissionHttpResponse {
  return { statusCode, contentType: undefined, cacheControl: "no-store", body: Buffer.alloc(0) };
}

function executionTerminalEvent() {
  const claim = execution().claim;
  const now = "2026-10-05T00:00:00.000Z";
  return {
    schemaVersion: 2,
    eventId: "60000000-0000-4000-8000-000000000001",
    occurredAt: now,
    eventType: "dim.ci.job.completed",
    payload: {
      reviewId: claim.reviewId,
      attemptId: claim.attemptId,
      attempt: claim.attempt,
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
  } as const;
}
