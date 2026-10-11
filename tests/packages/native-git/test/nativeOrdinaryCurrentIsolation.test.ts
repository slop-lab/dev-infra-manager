import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ordinaryAttemptStorePaths,
  writeOrdinaryAttempt
} from "../../../../core/packages/native-git/src/authoritative-ordinary-attempt-files.js";
import {
  createAuthoritativeOrdinaryAttemptStore
} from "../../../../core/packages/native-git/src/authoritative-ordinary-attempt-store.js";
import {
  authoritativeOrdinaryAttemptSchema
} from "../../../../core/packages/native-git/src/authoritative-ordinary-attempt-schema.js";
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
  closeFinalizeService,
  rootRepository,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native ordinary current selection isolation", () => {
  it("ignores corrupt unrelated attempt history without writes while startup still rejects it", async () => {
    // Given
    const fixture = await deliveredFixture("ordinary-current-isolated-history");
    const repository = rootRepository(fixture.root);
    const selectedAttempt = attemptPath(repository, String(fixture.review.reviewId));
    const selectedBefore = await readFile(selectedAttempt);
    const statusBefore = await readFile(statusRecordPath(fixture.root, fixture.review.reviewId));
    const unrelated = join(repository, "dim-authoritative-attempts", "ordinary-sysbox", "issuances",
      "f".repeat(64), "source");
    await mkdir(unrelated, { recursive: true, mode: 0o700 });
    await writeFile(join(unrelated, "1.json"), "{", { mode: 0o600 });
    const startedAt = performance.now();

    // When
    const evidence = await fixture.service.currentOrdinaryTerminalEvidence(selectorFor(fixture.review));

    // Then
    expect(evidence.attemptId).toBe(fixture.attempt.attemptId);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(await readFile(selectedAttempt)).toEqual(selectedBefore);
    expect(await readFile(statusRecordPath(fixture.root, fixture.review.reviewId))).toEqual(statusBefore);
    await closeFinalizeService(fixture.service);
    await expect(startFinalizeService(fixture.root)).rejects.toThrow();
  }, 30_000);

  it("fails closed when the selected attempt record is corrupt", async () => {
    // Given
    const fixture = await deliveredFixture("ordinary-current-selected-corruption");
    await writeFile(attemptPath(rootRepository(fixture.root), String(fixture.review.reviewId)), "{", { mode: 0o600 });

    // When / Then
    await expect(fixture.service.currentOrdinaryTerminalEvidence(selectorFor(fixture.review))).rejects.toThrow();
  }, 30_000);

  it("issues from only the selected bounded history when an unrelated job is corrupt", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-issue-isolated-history");
    const repository = rootRepository(fixture.root);
    const first = authoritativeOrdinaryAttemptSchema.parse(fixture.attempt);
    const unrelated = join(repository, "dim-authoritative-attempts", "ordinary-sysbox", "issuances",
      "f".repeat(64), "source");
    await mkdir(unrelated, { recursive: true, mode: 0o700 });
    await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(
      join(unrelated, `${index + 1}.json`), "{}\n", { mode: 0o600 }
    )));
    const store = createAuthoritativeOrdinaryAttemptStore(repository);
    const startedAt = performance.now();

    // When
    const issued = await store.issue({
      issuanceRequestId: randomUUID(),
      execution: { kind: "ordinary-sysbox", reviewId: first.reviewId,
        descriptor: first.descriptor, digest: first.descriptorDigest },
      hostId: first.hostId,
      capacity: first.capacity,
      issuedBy: first.issuedBy
    });

    // Then
    expect(issued.attempt).toBe(2);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(await readdir(unrelated)).toHaveLength(257);
  }, 30_000);

  it("revokes from only the exact current record when unrelated revocations are corrupt", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-revoke-isolated-history");
    const repository = rootRepository(fixture.root);
    const attempt = authoritativeOrdinaryAttemptSchema.parse(fixture.attempt);
    const unrelated = join(repository, "dim-authoritative-attempts", "ordinary-sysbox", "revocations",
      "f".repeat(64), "source");
    await mkdir(unrelated, { recursive: true, mode: 0o700 });
    await writeFile(join(unrelated, "1.json"), "{}\n", { mode: 0o600 });
    const store = createAuthoritativeOrdinaryAttemptStore(repository);

    // When
    const revocation = await store.revoke({
      revocationRequestId: attempt.attemptId,
      reviewId: attempt.reviewId,
      jobName: attempt.descriptor.jobName,
      attemptId: attempt.attemptId,
      revokedBy: attempt.issuedBy
    });

    // Then
    expect(revocation.attemptId).toBe(attempt.attemptId);
    expect(await readFile(join(unrelated, "1.json"), "utf8")).toBe("{}\n");
  }, 30_000);

  it("refuses to write an attempt beyond the explicit per-job bound", async () => {
    // Given
    const fixture = await ordinaryStatusFixture("ordinary-attempt-job-bound");
    const repository = rootRepository(fixture.root);
    const first = authoritativeOrdinaryAttemptSchema.parse(fixture.attempt);
    const paths = ordinaryAttemptStorePaths(repository);
    for (let attempt = 2; attempt <= 256; attempt += 1) {
      await writeOrdinaryAttempt(paths, { ...first, attempt, attemptId: randomUUID(), issuanceRequestId: randomUUID() });
    }
    const store = createAuthoritativeOrdinaryAttemptStore(repository);
    const nextPath = attemptPath(repository, first.reviewId, 257);

    // When / Then
    await expect(store.issue({
      issuanceRequestId: randomUUID(),
      execution: { kind: "ordinary-sysbox", reviewId: first.reviewId,
        descriptor: first.descriptor, digest: first.descriptorDigest },
      hostId: first.hostId,
      capacity: first.capacity,
      issuedBy: first.issuedBy
    })).rejects.toThrow(/bound/i);
    await expect(readFile(nextPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
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

function attemptPath(repository: string, reviewId: string, attempt = 1): string {
  return join(repository, "dim-authoritative-attempts", "ordinary-sysbox", "issuances", reviewId,
    "source", `${attempt}.json`);
}
