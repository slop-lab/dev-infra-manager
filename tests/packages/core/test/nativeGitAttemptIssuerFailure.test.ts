import { describe, expect, it } from "vitest";
import {
  createNativeGitAttemptIssuerClient,
  NativeGitAttemptIssuerUnavailableError,
  type NativeGitAttemptIssuerHttpClient,
  type NativeGitAttemptIssuerHttpResponse
} from "../../../../core/packages/managed/src/nativeGitAttemptIssuerClient.js";
import { nativeDescriptorDigest } from "../../../../core/packages/managed/src/nativeOrdinaryAuthorityModel.js";
import { descriptor as descriptorValue } from "./nativeOrdinaryDescriptorFixture.js";
import { reservationContext, schema2Event } from "./nativeRootReservationClaimFixture.js";

const reviewId = "a".repeat(64);
const generationId = "a".repeat(64);
const attemptIssuer = {
  username: "ordinary-attempts",
  password: "attempt-secret-000000000000000000000"
} as const;
const capacity = {
  hostId: "host-a",
  capacity: "primary",
  runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
  jobBaseImage: `registry.example/source@sha256:${"8".repeat(64)}`,
  bounds: {
    cpu: "2",
    memoryBytes: "2147483648",
    pids: "512",
    wallClockSeconds: "900",
    outputBytes: "10485760"
  }
} as const;
const nativeDescriptor = {
  ...descriptorValue("project-a", "root", "00000000-0000-4000-8000-000000000104"),
  policyRevision: "4".repeat(64),
  requiredReviewRevision: "5".repeat(64),
  requiredJobSetRevision: "6".repeat(64)
};
const context = reservationContext(schema2Event(nativeDescriptor, reviewId), capacity, generationId);
const canonicalDescriptor = {
  reviewId,
  descriptor: nativeDescriptor,
  digest: nativeDescriptorDigest(nativeDescriptor)
} as const;

describe("native Git attempt issuer response boundary", () => {
  it("keeps the credential in Basic authorization and sends only trusted descriptor selectors", async () => {
    // Given
    const requests: {
      readonly endpoint: string;
      readonly authorization: string;
      readonly generationId?: string;
      readonly body?: string;
    }[] = [];
    const client = createClient({
      async request(input) {
        requests.push(input);
        return response(200, descriptorEnvelope());
      }
    });

    // When
    await client.loadDescriptor(context);

    // Then
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      endpoint: "http://native-git:8080",
      authorization: `Basic ${Buffer.from(`${attemptIssuer.username}:${attemptIssuer.password}`).toString("base64")}`,
      generationId,
      body: JSON.stringify({
        schemaVersion: 1,
        jobName: context.claim.event.jobName,
        trustedCapacity: {
          admissionGeneration: context.claim.admissionGeneration,
          jobBaseImage: context.claim.jobBaseImage,
          runnerBaseImage: context.claim.runnerBaseImage,
          bounds: context.claim.bounds
        }
      })
    });
    expect(requests[0]?.body).not.toContain(attemptIssuer.password);
  });

  it("denies a service identity other than the fixed native Compose service", () => {
    // Given
    const config = { endpoint: "http://native-git:8080", serviceId: "native-main", attemptIssuer } as const;
    Reflect.set(config, "serviceId", "foreign-native");

    // When
    const create = () => createNativeGitAttemptIssuerClient({
      config,
      generationId,
      httpClient: { request: async () => response(200, descriptorEnvelope()) }
    });

    // Then
    expect(create).toThrow(NativeGitAttemptIssuerUnavailableError);
  });

  it.each([
    ["redirect", response(302, {})],
    ["malformed JSON", rawResponse(200, Buffer.from("{"))],
    ["additional field", response(200, { ...descriptorEnvelope(), unexpected: true })],
    ["foreign service", response(200, { ...descriptorEnvelope(), serviceId: "foreign-native" })],
    ["foreign generation", response(200, { ...descriptorEnvelope(), servingGenerationId: "b".repeat(64) })],
    ["wrong review", response(200, { ...descriptorEnvelope(), reviewId: "b".repeat(64) })],
    ["wrong digest", response(200, { ...descriptorEnvelope(), digest: `sha256:${"0".repeat(64)}` })]
  ])("denies a %s descriptor response", async (_label, fixtureResponse) => {
    // Given
    const client = clientReturning(fixtureResponse);

    // When
    const request = client.loadDescriptor(context);

    // Then
    await expect(request).rejects.toBeInstanceOf(NativeGitAttemptIssuerUnavailableError);
  });

  it("denies a timed-out transport", async () => {
    // Given
    const httpClient: NativeGitAttemptIssuerHttpClient = {
      request: async () => { throw new DOMException("timed out", "TimeoutError"); }
    };
    const client = createClient(httpClient);

    // When
    const request = client.loadDescriptor(context);

    // Then
    await expect(request).rejects.toBeInstanceOf(NativeGitAttemptIssuerUnavailableError);
  });

  it.each([
    ["wrong receipt", { issuanceRequestId: "00000000-0000-4000-8000-000000000099" }],
    ["wrong review", { reviewId: "b".repeat(64) }],
    ["wrong descriptor", { descriptorDigest: `sha256:${"0".repeat(64)}` }],
    ["wrong host", { hostId: "host-b" }],
    ["wrong capacity", { capacity: "backup" }],
    ["impossible issuance timestamp", { issuedAt: "2026-99-99T99:99:99Z" }]
  ])("denies issuance with %s", async (_label, override) => {
    // Given
    const receipt = "00000000-0000-4000-8000-000000000101";
    const issuance = {
      schemaVersion: 3,
      executionKind: "ordinary-sysbox",
      issuanceRequestId: receipt,
      attemptId: "00000000-0000-4000-8000-000000000201",
      reviewId,
      attempt: 1,
      descriptor: nativeDescriptor,
      descriptorDigest: canonicalDescriptor.digest,
      hostId: capacity.hostId,
      capacity: capacity.capacity,
      issuedBy: attemptIssuer.username,
      issuedAt: "2026-10-05T00:00:00.000Z",
      ...override
    };
    const client = clientReturning(response(201, issuanceEnvelope(issuance)));

    // When
    const request = client.issueAttempt({ context, descriptor: canonicalDescriptor });

    // Then
    await expect(request).rejects.toBeInstanceOf(NativeGitAttemptIssuerUnavailableError);
  });

  it.each([
    ["another attempt", { attemptId: "00000000-0000-4000-8000-000000000202" }],
    ["an impossible timestamp", { revokedAt: "2026-99-99T99:99:99Z" }]
  ])("denies a revocation bound to %s", async (_label, override) => {
    // Given
    const issuance = {
      schemaVersion: 3,
      executionKind: "ordinary-sysbox",
      issuanceRequestId: "00000000-0000-4000-8000-000000000101",
      attemptId: "00000000-0000-4000-8000-000000000201",
      reviewId,
      attempt: 1,
      descriptor: nativeDescriptor,
      descriptorDigest: canonicalDescriptor.digest,
      hostId: capacity.hostId,
      capacity: capacity.capacity,
      issuedBy: attemptIssuer.username,
      issuedAt: "2026-10-05T00:00:00.000Z"
    } as const;
    const revocation = {
      schemaVersion: 3,
      executionKind: "ordinary-sysbox",
      revocationRequestId: issuance.attemptId,
      revocationId: "00000000-0000-4000-8000-000000000301",
      attemptId: issuance.attemptId,
      reviewId,
      jobName: nativeDescriptor.jobName,
      attempt: 1,
      descriptorDigest: canonicalDescriptor.digest,
      hostId: capacity.hostId,
      capacity: capacity.capacity,
      revokedBy: attemptIssuer.username,
      revokedAt: "2026-10-05T00:00:01.000Z",
      ...override
    } as const;
    const client = clientReturning(response(201, revocationEnvelope(revocation)));

    // When
    const request = client.revokeAttempt(issuance);

    // Then
    await expect(request).rejects.toBeInstanceOf(NativeGitAttemptIssuerUnavailableError);
  });
});

function clientReturning(fixtureResponse: NativeGitAttemptIssuerHttpResponse) {
  return createClient({ request: async () => fixtureResponse });
}

function createClient(httpClient: NativeGitAttemptIssuerHttpClient) {
  return createNativeGitAttemptIssuerClient({
    config: { endpoint: "http://native-git:8080", serviceId: "native-main", attemptIssuer },
    generationId,
    httpClient
  });
}

function descriptorEnvelope() {
  return {
    schemaVersion: 1,
    serviceId: "native-main",
    servingGenerationId: generationId,
    kind: "ordinary-sysbox",
    ...canonicalDescriptor
  } as const;
}

function issuanceEnvelope(attempt: object) {
  return { schemaVersion: 1, serviceId: "native-main", servingGenerationId: generationId, attempt } as const;
}

function revocationEnvelope(revocation: object) {
  return { schemaVersion: 1, serviceId: "native-main", servingGenerationId: generationId, revocation } as const;
}

function response(statusCode: number, body: unknown): NativeGitAttemptIssuerHttpResponse {
  return rawResponse(statusCode, Buffer.from(`${JSON.stringify(body)}\n`));
}

function rawResponse(statusCode: number, body: Buffer): NativeGitAttemptIssuerHttpResponse {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-store",
    body
  };
}
