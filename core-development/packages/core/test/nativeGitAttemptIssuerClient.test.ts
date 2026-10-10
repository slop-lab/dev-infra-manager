import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeGitAttemptIssuerClient,
  type NativeGitAttemptIssuerHttpClient
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import {
  createBundleReview,
  nativeBundleReviewFixture,
  type NativeBundleReviewFixture
} from "../../native-git/test/nativeBundleReviewFixture.js";
import type { AuthoritativeNativeReviewEnvelope } from "../../../../core/packages/native-git/src/authoritative-native-review-schema.js";
import { parseNativeRootCiReviewEvent } from "../../../../core/packages/core/src/nativeRootCiReviewEvent.js";
import {
  cleanupFinalizeFixtures,
  generationId,
  rootRepository
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { reservationContext } from "./nativeRootReservationClaimFixture.js";

const attemptIssuer = {
  username: "ordinary-attempts",
  password: bundleSecrets.attemptIssuer
} as const;
const capacity = {
  hostId: "host-a",
  capacity: "primary",
  runnerBaseImage: `registry.example/runner@sha256:${"b".repeat(64)}`,
  jobBaseImage: `registry.example/job@sha256:${"a".repeat(64)}`,
  bounds: {
    cpu: "2",
    memoryBytes: "2147483648",
    pids: "512",
    wallClockSeconds: "900",
    outputBytes: "10485760"
  }
} as const;

afterEach(cleanupFinalizeFixtures);

describe("native Git attempt issuer installed denials", () => {
  it("sends the configured generation and rejects a wrong generation before descriptor derivation", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("core-attempt-wrong-generation");
    const envelope = await createBundleReview(fixture.service);
    const generations: (string | undefined)[] = [];
    const client = clientFor(fixture, "b".repeat(64), attemptIssuer, generations);

    // When
    const descriptor = client.loadDescriptor(contextFor(envelope.events));

    // Then
    await expect(descriptor).rejects.toThrow(/rejected/);
    expect(generations).toEqual(["b".repeat(64)]);
    expect(await attemptFiles(fixture, envelope.review.reviewId)).toEqual([]);
  });

  it("rejects a foreign installed role before descriptor derivation", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("core-attempt-wrong-role");
    const envelope = await createBundleReview(fixture.service);
    const client = clientFor(fixture, generationId, {
      username: "ordinary-results",
      password: bundleSecrets.resultReporter
    });

    // When
    const descriptor = client.loadDescriptor(contextFor(envelope.events));

    // Then
    await expect(descriptor).rejects.toThrow(/rejected/);
    expect(await attemptFiles(fixture, envelope.review.reviewId)).toEqual([]);
  });

  it("rejects a locally forged descriptor digest without creating attempt state", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("core-attempt-forged-descriptor");
    const envelope = await createBundleReview(fixture.service);
    const client = clientFor(fixture, generationId, attemptIssuer);
    const context = contextFor(envelope.events);
    const descriptor = await client.loadDescriptor(context);

    // When
    const issue = client.issueAttempt({
      context,
      descriptor: { ...descriptor, digest: `sha256:${"0".repeat(64)}` }
    });

    // Then
    await expect(issue).rejects.toThrow(/unavailable/);
    expect(await attemptFiles(fixture, envelope.review.reviewId)).toEqual([]);
  });
});

function clientFor(
  fixture: NativeBundleReviewFixture,
  selectedGenerationId: string,
  credential: { readonly username: string; readonly password: string },
  generations?: (string | undefined)[]
) {
  const transport = createNodeNativeGitAdmissionHttpClient();
  const httpClient: NativeGitAttemptIssuerHttpClient = {
    async request(input) {
      generations?.push(input.generationId);
      return transport.request({ ...input, endpoint: fixture.service.origin });
    }
  };
  return createNativeGitAttemptIssuerClient({
    config: { endpoint: "http://native-git:8080", serviceId: "native-main", attemptIssuer: credential },
    generationId: selectedGenerationId,
    httpClient
  });
}

function contextFor(events: AuthoritativeNativeReviewEnvelope["events"]) {
  const event = events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
  if (event === undefined) throw new TypeError("ordinary event is missing");
  return reservationContext(parseNativeRootCiReviewEvent(event), capacity, generationId);
}

async function attemptFiles(fixture: NativeBundleReviewFixture, reviewId: string): Promise<readonly string[]> {
  try {
    return await readdir(`${rootRepository(fixture.root)}/dim-authoritative-attempts/ordinary-sysbox/issuances/${reviewId}/source`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
