import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { bundleSecrets } from "./bundleConfigFixture.js";
import {
  createBundleReview,
  nativeBundleReviewFixture,
  reviewProposalRef
} from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  humanReviewerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

const issuerAuthorization = `Basic ${Buffer.from(
  `ordinary-attempts:${bundleSecrets.attemptIssuer}`
).toString("base64")}`;
const proofAuthorization = `Basic ${Buffer.from(
  `ordinary-identity:${bundleSecrets.nativeIdentity}`
).toString("base64")}`;
const trustedCapacity = {
  admissionGeneration: "ordinary-generation-7",
  jobBaseImage: `registry.example/job@sha256:${"a".repeat(64)}`,
  runnerBaseImage: `registry.example/runner@sha256:${"b".repeat(64)}`,
  bounds: {
    cpu: "2",
    memoryBytes: "2147483648",
    pids: "512",
    wallClockSeconds: "900",
    outputBytes: "10485760"
  }
} as const;
const issuanceRequestId = "00000000-0000-4000-8000-000000000041";
const proofRequestId = "00000000-0000-4000-8000-000000000042";
const claimAdmissionGeneration = "00000000-0000-4000-8000-000000000054";

const verifiedClaimClient: AdmissionVerifierHttpClient = {
  async request(input) {
    if (input.path !== "/v1/claim-reservation-verifications" || input.body === undefined) {
      throw new TypeError("unexpected ordinary query request");
    }
    const verification = record(JSON.parse(input.body));
    const claim = record(verification.claim);
    return {
      statusCode: 200,
      contentType: "application/json",
      cacheControl: "no-store",
      body: Buffer.from(JSON.stringify({ schemaVersion: 1, serviceId: "ordinary-main",
        requestId: verification.requestId, claimId: claim.claimId,
        issuanceRequestId: claim.issuanceRequestId, authorized: true }))
    };
  }
};

afterEach(cleanupFinalizeFixtures);

describe("installed native ordinary attempt authority HTTP boundary", () => {
  it("issues only from a query-verified full ordinary reservation claim", async () => {
    // Given
    let verificationCalls = 0;
    const ordinaryQuery: AdmissionVerifierHttpClient = {
      async request(input) {
        if (input.path !== "/v1/claim-reservation-verifications" || input.body === undefined) {
          throw new TypeError("unexpected ordinary query request");
        }
        verificationCalls += 1;
        const verification = record(JSON.parse(input.body));
        const claim = record(verification.claim);
        return {
          statusCode: 200,
          contentType: "application/json",
          cacheControl: "no-store",
          body: Buffer.from(JSON.stringify({
            schemaVersion: 1,
            serviceId: "ordinary-main",
            requestId: verification.requestId,
            claimId: claim.claimId,
            issuanceRequestId: claim.issuanceRequestId,
            authorized: true
          }))
        };
      }
    };
    const fixture = await nativeBundleReviewFixture(
      "ordinary-attempt-reservation-claim", undefined, undefined, undefined, ordinaryQuery
    );
    const envelope = await createBundleReview(fixture.service);
    const event = envelope.events.find((candidate) => candidate.executionKind === "ordinary-sysbox");
    if (event === undefined) throw new TypeError("ordinary event is missing");
    const claimAdmissionGeneration = "00000000-0000-4000-8000-000000000054";
    const descriptor = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "ordinary-execution-descriptors"), {
        schemaVersion: 1,
        jobName: "source",
        trustedCapacity: { ...trustedCapacity, admissionGeneration: claimAdmissionGeneration }
      }, issuerAuthorization);
    const descriptorDigest = stringField(await jsonRecord(descriptor), "digest");
    const claim = {
      schemaVersion: 1,
      serviceId: "ordinary-main",
      generationId,
      serviceEpochId: "00000000-0000-4000-8000-000000000051",
      requestId: "00000000-0000-4000-8000-000000000052",
      claimId: issuanceRequestId,
      issuanceRequestId,
      demandId: "00000000-0000-4000-8000-000000000053",
      admissionGeneration: claimAdmissionGeneration,
      eventDigest: `sha256:${"c".repeat(64)}`,
      event,
      admission: {
        projectId: "project-a",
        repositoryId: "root",
        importNonce: "00000000-0000-4000-8000-000000000055",
        rootSequence: 0,
        protectedRef: event.protectedRef,
        rootCommit: event.expectedProtectedHead,
        rootTree: event.candidateTree,
        policyDigest: "d".repeat(64),
        capacityConfigDigest: "e".repeat(64),
        leaseExpiresAt: 1_800_000_000_000
      },
      hostId: "host-a",
      capacity: "primary",
      runnerBaseImage: trustedCapacity.runnerBaseImage,
      jobBaseImage: trustedCapacity.jobBaseImage,
      bounds: trustedCapacity.bounds
    } as const;

    // When
    const issued = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "job-attempts"), {
        schemaVersion: 1,
        claim,
        descriptorDigest
      }, issuerAuthorization);

    // Then
    expect(issued.status).toBe(201);
    expect(verificationCalls).toBe(1);
    expect(recordField(await jsonRecord(issued), "attempt")).toMatchObject({
      issuanceRequestId: claim.claimId,
      reviewId: event.reviewId,
      hostId: claim.hostId,
      capacity: claim.capacity
    });
  });

  it("derives, durably issues, exactly replays after restart, proves, and revokes one ordinary attempt", async () => {
    // Given
    let claimIsCurrent = true;
    const replayingClaimClient: AdmissionVerifierHttpClient = {
      async request(input) {
        if (!claimIsCurrent) {
          return { statusCode: 409, contentType: "application/json", cacheControl: "no-store",
            body: Buffer.from(JSON.stringify({ error: "claim is no longer current" })) };
        }
        return verifiedClaimClient.request(input);
      }
    };
    const fixture = await nativeBundleReviewFixture(
      "ordinary-attempt-authority", undefined, undefined, undefined, replayingClaimClient
    );
    const envelope = await createBundleReview(fixture.service);
    const event = ordinaryEvent(envelope.events);
    const descriptorPath = reviewPath(envelope.review.reviewId, "ordinary-execution-descriptors");
    const identity = await fetch(`${fixture.service.origin}/v1/native-ordinary-attempt-proof/identity`, {
      headers: { authorization: proofAuthorization }
    });
    const descriptor = await request(fixture.service.origin, descriptorPath, {
      schemaVersion: 1, jobName: "source",
      trustedCapacity: { ...trustedCapacity, admissionGeneration: claimAdmissionGeneration }
    }, issuerAuthorization);
    const descriptorBody = await jsonRecord(descriptor);
    const descriptorDigest = stringField(descriptorBody, "digest");
    const issueBody = {
      schemaVersion: 1,
      descriptorDigest,
      claim: claimFor(event)
    } as const;

    // When
    const issued = await request(fixture.service.origin, reviewPath(envelope.review.reviewId, "job-attempts"),
      issueBody, issuerAuthorization);
    const issuedText = await issued.text();
    const issuedBody: unknown = JSON.parse(issuedText);
    const attempt = recordField(await record(issuedBody), "attempt");
    const attemptId = stringField(attempt, "attemptId");
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(
      fixture.root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, replayingClaimClient
    );
    const unrelated = join(rootRepository(fixture.root), "dim-authoritative-attempts", "ordinary-sysbox",
      "issuances", "f".repeat(64), "source");
    await mkdir(unrelated, { recursive: true, mode: 0o700 });
    await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(
      join(unrelated, `${index + 1}.json`), "{}\n", { mode: 0o600 }
    )));
    claimIsCurrent = false;
    const replayStartedAt = performance.now();
    const replay = await request(restarted.origin, reviewPath(envelope.review.reviewId, "job-attempts"),
      issueBody, issuerAuthorization);
    const replayElapsed = performance.now() - replayStartedAt;
    const replayText = await replay.text();
    await rm(join(rootRepository(fixture.root), "dim-authoritative-attempts", "ordinary-sysbox",
      "issuances", "f".repeat(64)), { recursive: true });
    const conflictingReplay = await request(restarted.origin,
      reviewPath(envelope.review.reviewId, "job-attempts"),
      { ...issueBody, claim: { ...issueBody.claim, capacity: "changed" } }, issuerAuthorization);
    const proof = await request(restarted.origin, proofPath("current-attempt"), {
      schemaVersion: 1,
      requestId: proofRequestId,
      reviewId: envelope.review.reviewId,
      executionKind: "ordinary-sysbox",
      jobName: "source",
      attemptId
    }, proofAuthorization);
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref",
      reviewProposalRef, envelope.review.expectedProtectedHead]);
    const changedDescriptorProof = await request(restarted.origin, proofPath("current-attempt"), {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      reviewId: envelope.review.reviewId,
      executionKind: "ordinary-sysbox",
      jobName: "source",
      attemptId
    }, proofAuthorization);
    const revoked = await request(restarted.origin,
      reviewPath(envelope.review.reviewId, "job-attempt-revocations"), {
        schemaVersion: 1, revocationRequestId: attemptId, jobName: "source", attemptId
      }, issuerAuthorization);
    const revokedText = await revoked.text();
    const deniedAfterRevocation = await request(restarted.origin, proofPath("current-attempt"), {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      reviewId: envelope.review.reviewId,
      executionKind: "ordinary-sysbox",
      jobName: "source",
      attemptId
    }, proofAuthorization);
    await closeFinalizeService(restarted);
    const restartedAfterRevocation = await startFinalizeService(
      fixture.root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, replayingClaimClient
    );
    const revocationReplay = await request(restartedAfterRevocation.origin,
      reviewPath(envelope.review.reviewId, "job-attempt-revocations"), {
        schemaVersion: 1, revocationRequestId: attemptId, jobName: "source", attemptId
      }, issuerAuthorization);
    const revocationReplayText = await revocationReplay.text();

    // Then
    expect(descriptor.status).toBe(200);
    expect(await identity.json()).toEqual({ schemaVersion: 1, serviceId: "native-main",
      role: "native-ordinary-attempt-proof-reader", scope: ["ordinary-current-attempt:read"], generationId });
    expect(issued.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replayText).toBe(issuedText);
    expect(replayElapsed).toBeLessThan(5_000);
    expect(conflictingReplay.status).toBe(409);
    expect(proof.status).toBe(200);
    expect(recordField(await jsonRecord(proof), "assignment")).toEqual(attempt);
    expect(changedDescriptorProof.status).toBe(409);
    expect(revoked.status).toBe(201);
    expect(revocationReplay.status).toBe(201);
    expect(revocationReplayText).toBe(revokedText);
    expect(deniedAfterRevocation.status).toBe(404);
    expect(await readFile(attemptPath(fixture.root, envelope.review.reviewId, "issuances"), "utf8"))
      .toBe(`${JSON.stringify(attempt)}\n`);
    expect(JSON.parse(await readFile(
       attemptPath(fixture.root, envelope.review.reviewId, "revocations"), "utf8"
    ))).toMatchObject({ schemaVersion: 3, executionKind: "ordinary-sysbox",
      revocationRequestId: attemptId, attemptId });
  }, 20_000);

  it("reads a sparse revocation for the second current attempt across restart", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture(
      "ordinary-second-attempt-revocation", undefined, undefined, undefined, verifiedClaimClient
    );
    const envelope = await createBundleReview(fixture.service);
    const event = ordinaryEvent(envelope.events);
    const descriptor = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "ordinary-execution-descriptors"), {
        schemaVersion: 1, jobName: "source",
        trustedCapacity: { ...trustedCapacity, admissionGeneration: claimAdmissionGeneration }
      }, issuerAuthorization);
    const digest = stringField(await jsonRecord(descriptor), "digest");
    const first = await request(fixture.service.origin, reviewPath(envelope.review.reviewId, "job-attempts"), {
      schemaVersion: 1, descriptorDigest: digest, claim: claimFor(event)
    }, issuerAuthorization);
    const secondClaim = { ...claimFor(event), claimId: crypto.randomUUID(), issuanceRequestId: crypto.randomUUID() };
    const second = await request(fixture.service.origin, reviewPath(envelope.review.reviewId, "job-attempts"), {
      schemaVersion: 1, descriptorDigest: digest,
      claim: { ...secondClaim, issuanceRequestId: secondClaim.claimId }
    }, issuerAuthorization);
    const attempt = recordField(await jsonRecord(second), "attempt");

    // When
    const revoked = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "job-attempt-revocations"), {
        schemaVersion: 1, revocationRequestId: stringField(attempt, "attemptId"), jobName: "source",
        attemptId: stringField(attempt, "attemptId")
      }, issuerAuthorization);
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(
      fixture.root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, verifiedClaimClient
    );
    const current = await request(restarted.origin, proofPath("current-attempt"), {
      schemaVersion: 1, requestId: crypto.randomUUID(), reviewId: envelope.review.reviewId,
      executionKind: "ordinary-sysbox", jobName: "source", attemptId: stringField(attempt, "attemptId")
    }, proofAuthorization);

    // Then
    expect([first.status, second.status, revoked.status, current.status]).toEqual([201, 201, 201, 404]);
    expect(await readdir(join(rootRepository(fixture.root), "dim-authoritative-attempts", "ordinary-sysbox",
      "revocations", envelope.review.reviewId, "source"))).toEqual(["2.json"]);
  }, 20_000);

  it("rejects a revocation request identity that differs from the attempt before writing", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture(
      "ordinary-revocation-request-identity", undefined, undefined, undefined, verifiedClaimClient
    );
    const envelope = await createBundleReview(fixture.service);
    const event = ordinaryEvent(envelope.events);
    const descriptor = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "ordinary-execution-descriptors"), {
        schemaVersion: 1, jobName: "source",
        trustedCapacity: { ...trustedCapacity, admissionGeneration: claimAdmissionGeneration }
      }, issuerAuthorization);
    const issued = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "job-attempts"), {
        schemaVersion: 1, descriptorDigest: stringField(await jsonRecord(descriptor), "digest"), claim: claimFor(event)
      }, issuerAuthorization);
    const attemptId = stringField(recordField(await jsonRecord(issued), "attempt"), "attemptId");

    // When
    const response = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "job-attempt-revocations"), {
        schemaVersion: 1, revocationRequestId: "00000000-0000-4000-8000-000000000043",
        jobName: "source", attemptId
      }, issuerAuthorization);

    // Then
    expect(response.status).toBe(400);
    await expect(readFile(attemptPath(fixture.root, envelope.review.reviewId, "revocations")))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("denies wrong role, stale generation, changed descriptor, QEMU crossover, and host claims", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture(
      "ordinary-attempt-denials", undefined, undefined, undefined, verifiedClaimClient
    );
    const envelope = await createBundleReview(fixture.service);
    const event = ordinaryEvent(envelope.events);
    const path = reviewPath(envelope.review.reviewId, "ordinary-execution-descriptors");
    const body = { schemaVersion: 1, jobName: "source",
      trustedCapacity: { ...trustedCapacity, admissionGeneration: claimAdmissionGeneration } } as const;
    const descriptor = await request(fixture.service.origin, path, body, issuerAuthorization);
    const descriptorDigest = stringField(await jsonRecord(descriptor), "digest");

    // When
    const responses = await Promise.all([
      request(fixture.service.origin, path, body, humanReviewerAuthorization),
      request(fixture.service.origin, path, body, issuerAuthorization, "f".repeat(64)),
      request(fixture.service.origin, path, { ...body, jobName: "integration" }, issuerAuthorization),
      request(fixture.service.origin, path, { ...body, executionKind: "qemu" }, issuerAuthorization),
      request(fixture.service.origin, proofPath("current-attempt"), {
        schemaVersion: 1,
        requestId: proofRequestId,
        reviewId: envelope.review.reviewId,
        executionKind: "ordinary-sysbox",
        jobName: "source",
        attemptId: "00000000-0000-4000-8000-000000000099"
      }, issuerAuthorization),
      request(fixture.service.origin, reviewPath(envelope.review.reviewId, "job-attempts"), {
        schemaVersion: 1,
        descriptorDigest,
        claim: { ...claimFor(event), jobBaseImage: `registry.example/changed@sha256:${"c".repeat(64)}` }
      }, issuerAuthorization),
      request(fixture.service.origin,
        "/v1/projects/project-a/repositories/root/ordinary-authority/current-attempt", {
          schemaVersion: 1, requestId: proofRequestId, reviewId: envelope.review.reviewId,
          jobName: "source", attemptId: "00000000-0000-4000-8000-000000000099"
        }, proofAuthorization),
      request(fixture.service.origin, "/v1/host-claims", { schemaVersion: 1 }, issuerAuthorization)
    ]);

    // Then
    expect(responses.map(({ status }) => status)).toEqual([403, 409, 409, 400, 403, 409, 404, 404]);
  });

  it("rejects a malformed schema-3 attempt record on restart without rewriting it", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture(
      "ordinary-attempt-corruption", undefined, undefined, undefined, verifiedClaimClient
    );
    const envelope = await createBundleReview(fixture.service);
    const event = ordinaryEvent(envelope.events);
    const descriptor = await request(fixture.service.origin,
      reviewPath(envelope.review.reviewId, "ordinary-execution-descriptors"), {
        schemaVersion: 1, jobName: "source",
        trustedCapacity: { ...trustedCapacity, admissionGeneration: claimAdmissionGeneration }
      }, issuerAuthorization);
    const descriptorDigest = stringField(await jsonRecord(descriptor), "digest");
    await request(fixture.service.origin, reviewPath(envelope.review.reviewId, "job-attempts"), {
      schemaVersion: 1, descriptorDigest, claim: claimFor(event)
    }, issuerAuthorization);
    const path = attemptPath(fixture.root, envelope.review.reviewId, "issuances");
    await closeFinalizeService(fixture.service);
    const malformed = `${JSON.stringify({ schemaVersion: 2, executionKind: "ordinary-sysbox" })}\n`;
    await writeFile(path, malformed);

    // When
    const restart = startFinalizeService(fixture.root);

    // Then
    await expect(restart).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(malformed);
  });
});

function reviewPath(reviewId: string, action: string): string {
  return `/v1/projects/project-a/repositories/root/reviews/${reviewId}/${action}`;
}

function proofPath(action: string): string {
  return `/v1/projects/project-a/repositories/root/native-ordinary-attempt-proof/${action}`;
}

function attemptPath(root: string, reviewId: string, kind: "issuances" | "revocations", attempt = 1): string {
  return join(rootRepository(root), "dim-authoritative-attempts", "ordinary-sysbox", kind, reviewId,
    "source", `${attempt}.json`);
}

function request(
  origin: string,
  path: string,
  body: object,
  authorization: string,
  servingGenerationId = generationId
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-dim-generation-id": servingGenerationId
    },
    body: JSON.stringify(body)
  });
}

async function jsonRecord(response: Response): Promise<Readonly<Record<string, unknown>>> {
  return record(await response.json());
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError("expected record");
  return value;
}

function recordField(value: Readonly<Record<string, unknown>>, field: string): Readonly<Record<string, unknown>> {
  const selected = value[field];
  if (!isRecord(selected)) throw new TypeError("expected record field");
  return selected;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const selected = value[field];
  if (typeof selected !== "string") throw new TypeError("expected string field");
  return selected;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ordinaryEvent(events: readonly unknown[]): Readonly<Record<string, unknown>> {
  const event = events.map(record).find((candidate) => candidate.executionKind === "ordinary-sysbox");
  if (event === undefined) throw new TypeError("ordinary event is missing");
  return event;
}

function claimFor(event: Readonly<Record<string, unknown>>) {
  return {
    schemaVersion: 1, serviceId: "ordinary-main", generationId,
    serviceEpochId: "00000000-0000-4000-8000-000000000051",
    requestId: "00000000-0000-4000-8000-000000000052",
    claimId: issuanceRequestId, issuanceRequestId,
    demandId: "00000000-0000-4000-8000-000000000053",
    admissionGeneration: claimAdmissionGeneration,
    eventDigest: `sha256:${"c".repeat(64)}`, event,
    admission: {
      projectId: event.projectId, repositoryId: "root",
      importNonce: "00000000-0000-4000-8000-000000000055", rootSequence: 0,
      protectedRef: event.protectedRef, rootCommit: event.expectedProtectedHead,
      rootTree: event.candidateTree, policyDigest: "d".repeat(64),
      capacityConfigDigest: "e".repeat(64), leaseExpiresAt: 1_800_000_000_000
    },
    hostId: "host-a", capacity: "primary",
    runnerBaseImage: trustedCapacity.runnerBaseImage, jobBaseImage: trustedCapacity.jobBaseImage,
    bounds: trustedCapacity.bounds
  } as const;
}
