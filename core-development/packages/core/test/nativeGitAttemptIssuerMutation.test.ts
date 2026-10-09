import { describe, expect, it } from "vitest";
import {
  createNativeGitAttemptIssuerClient,
  type NativeGitAttemptIssuerConfig,
  type NativeGitAttemptIssuerHttpClient,
  type NativeGitAttemptIssuerHttpResponse
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import { descriptor as descriptorValue } from "./nativeOrdinaryAuthorityFixture.js";

const originalReceipt = "00000000-0000-4000-8000-000000000101";
const nativeDescriptor = descriptorValue("project-a", "source", "generation-7");
const descriptor = {
  reviewId: "a".repeat(64),
  descriptor: nativeDescriptor,
  digest: nativeDescriptorDigest(nativeDescriptor)
} as const;
const context = {
  event: {
    schemaVersion: 1,
    type: "dim.native.review-job.available",
    eventId: "00000000-0000-4000-8000-000000000001",
    projectId: nativeDescriptor.projectId,
    repositoryId: nativeDescriptor.repositoryId,
    protectedRef: nativeDescriptor.protectedRef,
    reviewId: descriptor.reviewId,
    expectedProtectedHead: nativeDescriptor.expectedProtectedHead,
    candidateCommit: nativeDescriptor.candidateCommit,
    candidateTree: nativeDescriptor.candidateTree,
    policyRevision: nativeDescriptor.policyRevision,
    requiredReviewRevision: nativeDescriptor.requiredReviewRevision,
    requiredJobSetRevision: nativeDescriptor.requiredJobSetRevision,
    jobName: nativeDescriptor.jobName,
    evidenceClass: "candidate-controlled"
  },
  admissionGeneration: nativeDescriptor.admissionGeneration,
  capacity: {
    hostId: "host-a",
    capacity: "primary",
    jobBaseImage: nativeDescriptor.jobImage,
    runnerBaseImage: nativeDescriptor.runnerBaseImage,
    bounds: nativeDescriptor.bounds
  }
} as const;
const credential = {
  username: "ordinary-attempts",
  password: "attempt-secret-000000000000000000000"
} as const;

describe("native Git attempt issuer mutation boundaries", () => {
  it("retains the fixed origin and Basic credential after caller config mutation", async () => {
    // Given
    const seen: { readonly endpoint: string; readonly authorization: string }[] = [];
    const config: NativeGitAttemptIssuerConfig = {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      attemptIssuer: { ...credential }
    };
    const client = createNativeGitAttemptIssuerClient({
      config,
      httpClient: {
        async request(input) {
          seen.push(input);
          return response(200, descriptor);
        }
      }
    });
    Reflect.set(config, "endpoint", "http://attacker.invalid:9999");
    Reflect.set(config.attemptIssuer, "username", "attacker");
    Reflect.set(config.attemptIssuer, "password", "attacker-password-0000000000000000");

    // When
    await client.loadDescriptor(context);

    // Then
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      endpoint: "http://native-git:8080",
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`
    });
  });

  it("binds an in-flight issuance to the receipt and descriptor parsed before transport", async () => {
    // Given
    const entered = deferred();
    const release = deferred();
    const requestBodies: string[] = [];
    const httpClient: NativeGitAttemptIssuerHttpClient = {
      async request(input) {
        requestBodies.push(input.body ?? "");
        entered.resolve();
        await release.promise;
        return response(201, issuance());
      }
    };
    const client = createClient(httpClient);
    const input = { issuanceRequestId: originalReceipt, context, descriptor };
    const pending = client.issueAttempt(input);
    await entered.promise;

    // When
    Reflect.set(input, "issuanceRequestId", "00000000-0000-4000-8000-000000000999");
    Reflect.set(input, "descriptor", { ...descriptor, digest: `sha256:${"0".repeat(64)}` });
    release.resolve();

    // Then
    await expect(pending).resolves.toMatchObject({
      replayed: false,
      issuance: { issuanceRequestId: originalReceipt, descriptorDigest: descriptor.digest }
    });
    expect(requestBodies).toEqual([JSON.stringify({
      issuanceRequestId: originalReceipt,
      jobName: context.event.jobName,
      descriptorDigest: descriptor.digest,
      admissionGeneration: context.admissionGeneration,
      jobBaseImage: context.capacity.jobBaseImage,
      runnerBaseImage: context.capacity.runnerBaseImage,
      bounds: context.capacity.bounds,
      hostId: context.capacity.hostId,
      capacity: context.capacity.capacity
    })]);
  });
});

function issuance() {
  return {
    schemaVersion: 2,
    issuanceRequestId: originalReceipt,
    attemptId: "00000000-0000-4000-8000-000000000201",
    reviewId: descriptor.reviewId,
    attempt: 1,
    descriptor: nativeDescriptor,
    descriptorDigest: descriptor.digest,
    hostId: context.capacity.hostId,
    capacity: context.capacity.capacity,
    issuedBy: credential.username,
    issuedAt: "2026-10-05T00:00:00.000Z"
  } as const;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolver = resolve; });
  return {
    promise,
    resolve() {
      if (resolver === undefined) throw new TypeError("deferred resolver is unavailable");
      resolver();
    }
  };
}

function createClient(httpClient: NativeGitAttemptIssuerHttpClient) {
  return createNativeGitAttemptIssuerClient({
    config: { endpoint: "http://native-git:8080", serviceId: "native-main", attemptIssuer: credential },
    httpClient
  });
}

function response(statusCode: number, body: unknown): NativeGitAttemptIssuerHttpResponse {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-store",
    body: Buffer.from(`${JSON.stringify(body)}\n`)
  };
}
