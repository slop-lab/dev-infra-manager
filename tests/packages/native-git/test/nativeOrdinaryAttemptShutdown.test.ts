import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import type { AdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

const issuerAuthorization = `Basic ${Buffer.from(
  `ordinary-attempts:${bundleSecrets.attemptIssuer}`
).toString("base64")}`;
const trustedCapacity = {
  admissionGeneration: "00000000-0000-4000-8000-000000000054",
  jobBaseImage: `registry.example/job@sha256:${"a".repeat(64)}`,
  runnerBaseImage: `registry.example/runner@sha256:${"b".repeat(64)}`,
  bounds: { cpu: "2", memoryBytes: "2147483648", pids: "512", wallClockSeconds: "900", outputBytes: "10485760" }
} as const;
const ordinaryQuery: AdmissionVerifierHttpClient = {
  async request(input) {
    if (input.path !== "/v1/claim-reservation-verifications" || input.body === undefined) throw new TypeError();
    const verification = JSON.parse(input.body);
    const claim = Reflect.get(verification, "claim");
    return { statusCode: 200, contentType: "application/json", cacheControl: "no-store",
      body: Buffer.from(JSON.stringify({ schemaVersion: 1, serviceId: "ordinary-main",
        requestId: Reflect.get(verification, "requestId"), claimId: Reflect.get(claim, "claimId"),
        issuanceRequestId: Reflect.get(claim, "issuanceRequestId"), authorized: true })) };
  }
};

afterEach(cleanupFinalizeFixtures);

describe("installed native ordinary attempt shutdown", () => {
  it("drains an admitted issuance before releasing the storage owner", { timeout: 15_000 }, async () => {
    // Given
    let enterIssue: (() => void) | undefined;
    let releaseIssue: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enterIssue = resolve; });
    const released = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const fixture = await nativeBundleReviewFixture(
      "ordinary-attempt-shutdown", undefined, undefined, undefined, ordinaryQuery, undefined,
      { async beforeIssue() { enterIssue?.(); await released; } }
    );
    const envelope = await createBundleReview(fixture.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary event missing");
    const descriptor = await post(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "ordinary-execution-descriptors"), {
        schemaVersion: 1, jobName: "source", trustedCapacity
      });
    const descriptorBody: unknown = await descriptor.json();
    if (typeof descriptorBody !== "object" || descriptorBody === null) throw new TypeError("descriptor missing");
    const descriptorDigest = Reflect.get(descriptorBody, "digest");
    if (typeof descriptorDigest !== "string") throw new TypeError("descriptor digest missing");
    const issuing = post(fixture.service.origin, reviewPath(envelope.review.reviewId, "job-attempts"), {
      schemaVersion: 1,
      descriptorDigest,
      claim: {
        schemaVersion: 1, serviceId: "ordinary-main", generationId,
        serviceEpochId: "00000000-0000-4000-8000-000000000051",
        requestId: "00000000-0000-4000-8000-000000000052",
        claimId: "00000000-0000-4000-8000-000000000053",
        issuanceRequestId: "00000000-0000-4000-8000-000000000053",
        demandId: "00000000-0000-4000-8000-000000000055",
        admissionGeneration: trustedCapacity.admissionGeneration,
        eventDigest: `sha256:${"c".repeat(64)}`, event,
        admission: { projectId: event.projectId, repositoryId: "root",
          importNonce: "00000000-0000-4000-8000-000000000056", rootSequence: 0,
          protectedRef: event.protectedRef, rootCommit: event.expectedProtectedHead, rootTree: event.candidateTree,
          policyDigest: "d".repeat(64), capacityConfigDigest: "e".repeat(64), leaseExpiresAt: 1_800_000_000_000 },
        hostId: "host-a", capacity: "primary", runnerBaseImage: trustedCapacity.runnerBaseImage,
        jobBaseImage: trustedCapacity.jobBaseImage, bounds: trustedCapacity.bounds
      }
    });
    await entered;

    // When
    let closed = false;
    const closing = closeFinalizeService(fixture.service).then(() => { closed = true; });
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/active server/);

    // Then
    expect(closed).toBe(false);
    releaseIssue?.();
    expect((await issuing).status).toBe(201);
    await closing;
    const restarted = await startFinalizeService(fixture.root);
    expect(restarted.server.listening).toBe(true);
  });
});

function reviewPath(reviewId: string, action: string): string {
  return `/v1/projects/project-a/repositories/root/reviews/${reviewId}/${action}`;
}

function post(origin: string, path: string, body: object): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: issuerAuthorization,
      "content-type": "application/json",
      "x-dim-generation-id": generationId
    },
    body: JSON.stringify(body)
  });
}
