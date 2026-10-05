import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeGitAttemptIssuerClient,
  type NativeGitAttemptIssuerHttpClient
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import {
  nativeGitReviewFixture,
  readJsonObject,
  reviewPath,
  stringField,
  type JsonObject,
  type ReviewFixture
} from "../../native-git/test/nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];
const attemptIssuer = {
  username: "ordinary-attempts",
  password: "attempt-credential-secret"
} as const;
const capacity = {
  hostId: "host-a",
  capacity: "primary",
  runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
  bounds: {
    cpu: "2",
    memoryBytes: "2147483648",
    pids: "512",
    wallClockSeconds: "900",
    outputBytes: "10485760"
  }
} as const;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native Git attempt issuer client", () => {
  it("derives one canonical descriptor and issues the receipt once with an exact replay", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const issueBodies: string[] = [];
    const client = clientFor(fixture, attemptIssuer, issueBodies);
    const context = contextFor(review);

    // When
    const descriptor = await client.loadDescriptor(context);
    const first = await client.issueAttempt({
      issuanceRequestId: "00000000-0000-4000-8000-000000000101",
      context,
      descriptor
    });
    const replay = await client.issueAttempt({
      issuanceRequestId: "00000000-0000-4000-8000-000000000101",
      context,
      descriptor
    });

    // Then
    expect(descriptor.reviewId).toBe(context.event.reviewId);
    expect(descriptor.descriptor).toMatchObject({
      projectId: context.event.projectId,
      repositoryId: context.event.repositoryId,
      candidateCommit: context.event.candidateCommit,
      candidateTree: context.event.candidateTree,
      jobName: context.event.jobName,
      runnerBaseImage: capacity.runnerBaseImage,
      bounds: capacity.bounds
    });
    expect([first.replayed, replay.replayed]).toEqual([false, true]);
    expect(replay.issuance).toEqual(first.issuance);
    expect(issueBodies).toHaveLength(2);
    expect(new Set(issueBodies).size).toBe(1);
    expect(first.issuance.issuanceRequestId).toBe("00000000-0000-4000-8000-000000000101");
    expect(JSON.stringify([descriptor, first, replay])).not.toMatch(/credential|password|secret/i);
    expect(await attemptFiles(fixture, context.event.reviewId)).toEqual(["1.json"]);
  });

  it("revokes only the exact issued attempt and parses its bound revocation", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const client = clientFor(fixture, attemptIssuer);
    const context = contextFor(review);
    const descriptor = await client.loadDescriptor(context);
    const issued = await client.issueAttempt({
      issuanceRequestId: "00000000-0000-4000-8000-000000000102",
      context,
      descriptor
    });

    // When
    const revocation = await client.revokeAttempt(issued.issuance);

    // Then
    expect(revocation).toMatchObject({
      schemaVersion: 2,
      reviewId: context.event.reviewId,
      jobName: context.event.jobName,
      attemptId: issued.issuance.attemptId,
      descriptorDigest: descriptor.digest,
      hostId: capacity.hostId,
      capacity: capacity.capacity,
      revokedBy: attemptIssuer.username
    });
  });

  it("replays the exact issuance request bytes after the first native response is lost", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const context = contextFor(review);
    const transport = createNodeNativeGitAdmissionHttpClient();
    const issueBodies: string[] = [];
    let loseResponse = true;
    const client = createNativeGitAttemptIssuerClient({
      config: { endpoint: "http://native-git:8080", serviceId: "native-main", attemptIssuer },
      httpClient: {
        async request(input) {
          const response = await transport.request({ ...input, endpoint: fixture.baseUrl() });
          if (!input.path.endsWith("/job-attempts")) return response;
          issueBodies.push(input.body ?? "");
          if (loseResponse) {
            loseResponse = false;
            throw new Error("response lost after native persistence");
          }
          return response;
        }
      }
    });
    const descriptor = await client.loadDescriptor(context);
    const input = {
      issuanceRequestId: "00000000-0000-4000-8000-000000000105",
      context,
      descriptor
    };

    // When
    await expect(client.issueAttempt(input)).rejects.toThrow(/unavailable/);
    const replay = await client.issueAttempt(input);

    // Then
    expect(replay.replayed).toBe(true);
    expect(issueBodies).toHaveLength(2);
    expect(new Set(issueBodies).size).toBe(1);
    expect(await attemptFiles(fixture, context.event.reviewId)).toEqual(["1.json"]);
  });

  it.each([
    ["obsolete generation", attemptIssuer, (review: JsonObject) => ({ ...contextFor(review), admissionGeneration: "generation-8" })],
    ["wrong host", attemptIssuer, (review: JsonObject) => ({ ...contextFor(review), capacity: { ...capacity, hostId: "host-b" } })],
    ["wrong capacity", attemptIssuer, (review: JsonObject) => ({ ...contextFor(review), capacity: { ...capacity, capacity: "backup" } })]
  ] as const)("denies %s without creating attempt state", async (_label, credential, makeContext) => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const context = makeContext(review);
    const client = clientFor(fixture, credential);
    const descriptor = await client.loadDescriptor(context);

    // When
    const issue = client.issueAttempt({
      issuanceRequestId: "00000000-0000-4000-8000-000000000103",
      context,
      descriptor
    });

    // Then
    await expect(issue).rejects.toThrow();
    expect(await attemptFiles(fixture, context.event.reviewId)).toEqual([]);
  });

  it("denies a wrong service role before descriptor derivation without creating attempt state", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const context = contextFor(review);
    const client = clientFor(fixture, {
      username: "ordinary-results",
      password: "reporter-credential-secret"
    });

    // When
    const descriptor = client.loadDescriptor(context);

    // Then
    await expect(descriptor).rejects.toThrow();
    expect(await attemptFiles(fixture, context.event.reviewId)).toEqual([]);
  });

  it("denies a wrong descriptor digest without creating attempt state", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const context = contextFor(review);
    const client = clientFor(fixture, attemptIssuer);
    const descriptor = await client.loadDescriptor(context);

    // When
    const issue = client.issueAttempt({
      issuanceRequestId: "00000000-0000-4000-8000-000000000104",
      context,
      descriptor: { ...descriptor, digest: `sha256:${"0".repeat(64)}` }
    });

    // Then
    await expect(issue).rejects.toThrow();
    expect(await attemptFiles(fixture, context.event.reviewId)).toEqual([]);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

async function createPendingReview(fixture: ReviewFixture): Promise<JsonObject> {
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: fixture.proposalRef
  });
  expect(response.status).toBe(201);
  return readJsonObject(response);
}

function contextFor(review: JsonObject) {
  return {
    event: {
      schemaVersion: 1,
      type: "dim.native.review-job.available",
      eventId: "00000000-0000-4000-8000-000000000001",
      projectId: "project-a",
      repositoryId: "source",
      protectedRef: "refs/heads/main",
      reviewId: stringField(review, "reviewId"),
      expectedProtectedHead: stringField(review, "expectedProtectedHead"),
      candidateCommit: stringField(review, "candidateCommit"),
      candidateTree: stringField(review, "candidateTree"),
      policyRevision: "policy-1",
      requiredReviewRevision: "review-1",
      requiredJobSetRevision: "jobs-1",
      jobName: "source",
      evidenceClass: "candidate-controlled"
    },
    admissionGeneration: "generation-7",
    capacity
  } as const;
}

function clientFor(
  fixture: ReviewFixture,
  credential: { readonly username: string; readonly password: string },
  issueBodies?: string[]
) {
  const transport = createNodeNativeGitAdmissionHttpClient();
  const httpClient: NativeGitAttemptIssuerHttpClient = {
    async request(input) {
      const response = await transport.request({ ...input, endpoint: fixture.baseUrl() });
      if (input.path.endsWith("/job-attempts")) issueBodies?.push(input.body ?? "");
      return response;
    }
  };
  return createNativeGitAttemptIssuerClient({
    config: { endpoint: "http://native-git:8080", serviceId: "native-main", attemptIssuer: credential },
    httpClient
  });
}

async function attemptFiles(fixture: ReviewFixture, reviewId: string): Promise<readonly string[]> {
  try {
    return await readdir(`${fixture.repositoryPath}/dim-reviews/job-attempts/${reviewId}/source`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
