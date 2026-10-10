import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  attemptIssuerAuthorization,
  ordinaryStatusFixture,
  post,
  resultReporterAuthorization,
  statusRecordPath,
  statusReviewPath
} from "./nativeOrdinaryStatusFixture.js";
import {
  cleanupFinalizeFixtures,
  rootRepository,
  runGit
} from "./nativeRootImportFinalizeFixture.js";
import { reviewProposalRef } from "./nativeBundleReviewFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native ordinary terminal evidence", () => {
  it("rechecks the local tuple after ordinary proof without holding the native serializer", async () => {
    // Given
    const fixture = await deliveredFixture("ordinary-terminal-race");
    const selector = selectorFor(fixture.review);
    const payload = record(fixture.event.payload);
    fixture.proof.beforeTerminalResponse = async () => {
      expect((await post(fixture.service.origin,
        statusReviewPath(selector.reviewId, "job-attempt-revocations"), {
          schemaVersion: 1,
          revocationRequestId: payload.attemptId,
          jobName: "source",
          attemptId: payload.attemptId
        }, attemptIssuerAuthorization)).status).toBe(201);
    };

    // When
    const operation = fixture.service.currentOrdinaryTerminalEvidence(selector);

    // Then
    await expect(operation).rejects.toThrow();
  }, 30_000);

  it("rejects denied and malformed ordinary proofs without native mutation", async () => {
    // Given
    const fixture = await deliveredFixture("ordinary-terminal-proof-rejections");
    const selector = selectorFor(fixture.review);
    const before = await nativeSnapshot(fixture.root, selector.reviewId);

    // When
    fixture.proof.terminalStatusCode = 409;
    await expect(fixture.service.currentOrdinaryTerminalEvidence(selector)).rejects.toThrow();
    delete fixture.proof.terminalStatusCode;
    fixture.proof.terminalOverride = { serviceId: "wrong-ordinary" };
    await expect(fixture.service.currentOrdinaryTerminalEvidence(selector)).rejects.toThrow();
    fixture.proof.terminalOverride = { admissionGeneration: randomUUID() };
    await expect(fixture.service.currentOrdinaryTerminalEvidence(selector)).rejects.toThrow();
    fixture.proof.terminalOverride = { rootCommit: "f".repeat(40) };
    await expect(fixture.service.currentOrdinaryTerminalEvidence(selector)).rejects.toThrow();
    fixture.proof.terminalOverride = { unexpected: true };
    await expect(fixture.service.currentOrdinaryTerminalEvidence(selector)).rejects.toThrow();

    // Then
    expect(await nativeSnapshot(fixture.root, selector.reviewId)).toEqual(before);
  }, 30_000);

  it("rejects foreign selectors, stale review and root, revoked or replaced attempts, and forged local status", async () => {
    // Given
    const foreign = await deliveredFixture("ordinary-terminal-foreign");
    const foreignSelector = selectorFor(foreign.review);
    const stale = await deliveredFixture("ordinary-terminal-stale");
    const staleSelector = selectorFor(stale.review);
    const revoked = await deliveredFixture("ordinary-terminal-revoked");
    const revokedSelector = selectorFor(revoked.review);
    const replaced = await deliveredFixture("ordinary-terminal-replaced");
    const replacedSelector = selectorFor(replaced.review);
    const staleRoot = await deliveredFixture("ordinary-terminal-stale-root");
    const staleRootSelector = selectorFor(staleRoot.review);
    const forged = await deliveredFixture("ordinary-terminal-forged");
    const forgedSelector = selectorFor(forged.review);

    // When
    await expect(foreign.service.currentOrdinaryTerminalEvidence({
      ...foreignSelector,
      projectId: "project-b"
    })).rejects.toThrow();
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(stale.root), "update-ref",
      reviewProposalRef, String(stale.review.expectedProtectedHead)]);
    await expect(stale.service.currentOrdinaryTerminalEvidence(staleSelector)).rejects.toThrow();
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(staleRoot.root), "update-ref",
      "refs/heads/main", String(staleRoot.review.candidateCommit)]);
    const staleRootBefore = await nativeSnapshot(staleRoot.root, staleRootSelector.reviewId);
    await expect(staleRoot.service.currentOrdinaryTerminalEvidence(staleRootSelector)).rejects.toThrow();
    expect(await nativeSnapshot(staleRoot.root, staleRootSelector.reviewId)).toEqual(staleRootBefore);
    const revokedPayload = record(revoked.event.payload);
    expect((await post(revoked.service.origin,
      statusReviewPath(revokedSelector.reviewId, "job-attempt-revocations"), {
        schemaVersion: 1,
        revocationRequestId: revokedPayload.attemptId,
        jobName: "source",
        attemptId: revokedPayload.attemptId
      }, attemptIssuerAuthorization)).status).toBe(201);
    await expect(revoked.service.currentOrdinaryTerminalEvidence(revokedSelector)).rejects.toThrow();
    const replacedPayload = record(replaced.event.payload);
    expect((await post(replaced.service.origin,
      statusReviewPath(replacedSelector.reviewId, "job-attempt-revocations"), {
        schemaVersion: 1,
        revocationRequestId: replacedPayload.attemptId,
        jobName: "source",
        attemptId: replacedPayload.attemptId
      }, attemptIssuerAuthorization)).status).toBe(201);
    const replacementClaimId = randomUUID();
    const replacementClaim = {
      ...replaced.claim,
      requestId: randomUUID(),
      claimId: replacementClaimId,
      issuanceRequestId: replacementClaimId,
      demandId: randomUUID(),
      serviceEpochId: randomUUID()
    };
    expect((await post(replaced.service.origin,
      statusReviewPath(replacedSelector.reviewId, "job-attempts"), {
        schemaVersion: 1,
        descriptorDigest: replacedPayload.descriptorDigest,
        claim: replacementClaim
      }, attemptIssuerAuthorization)).status).toBe(201);
    await expect(replaced.service.currentOrdinaryTerminalEvidence(replacedSelector)).rejects.toThrow();
    const forgedPath = statusRecordPath(forged.root, forgedSelector.reviewId);
    const forgedStatus = record(JSON.parse(await readFile(forgedPath, "utf8")));
    await writeFile(forgedPath, `${JSON.stringify({ ...forgedStatus, unexpected: true })}\n`);
    await expect(forged.service.currentOrdinaryTerminalEvidence(forgedSelector)).rejects.toThrow();
  }, 45_000);
});

async function deliveredFixture(label: string) {
  const fixture = await ordinaryStatusFixture(label);
  expect((await post(fixture.service.origin, statusReviewPath(fixture.review.reviewId),
    fixture.event, resultReporterAuthorization)).status).toBe(201);
  return fixture;
}

function selectorFor(review: Readonly<Record<string, unknown>>) {
  if (typeof review.reviewId !== "string") throw new TypeError("review ID is missing");
  return { projectId: "project-a", reviewId: review.reviewId, jobName: "source" } as const;
}

async function nativeSnapshot(root: string, reviewId: string) {
  const repository = rootRepository(root);
  return {
    database: await readFile(`${root}/.dim-native-git-owner.sqlite3`),
    refs: (await runGit("/usr/bin/git", ["--git-dir", repository, "show-ref"])).stdout,
    status: await readFile(statusRecordPath(root, reviewId))
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected record");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
