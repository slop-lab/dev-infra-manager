import { randomUUID } from "node:crypto";
import { link, open, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import {
  readPendingAuthoritativeNativeDeliveries,
  recordExplicitAuthoritativeNativeDeliveryIntent,
  supersedeAuthoritativeNativeDelivery
} from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import * as recordStorage from "../../../../packages/control-plane/plugins/git-review/src/review-record-storage.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  generationId,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFinalizeFixtures();
});

it("serializes reads behind a live two-link intent publication", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-publication-race");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new IntentConcurrencyFixtureError("review envelope is missing");
  const nextGeneration = "b".repeat(64);
  let publicationStarted: (() => void) | undefined;
  let releasePublication: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { publicationStarted = resolve; });
  const release = new Promise<void>((resolve) => { releasePublication = resolve; });
  const originalPublish = recordStorage.publishReviewRecord;
  let paused = false;
  vi.spyOn(recordStorage, "publishReviewRecord").mockImplementation(async (publication) => {
    if (paused || !publication.stagingRoot.endsWith("/intent-staging")) return originalPublish(publication);
    paused = true;
    const stagedPath = join(publication.stagingRoot, `${basename(publication.path)}.${randomUUID()}.tmp`);
    await writeDurable(stagedPath, publication.serialized);
    await link(stagedPath, publication.path);
    publicationStarted?.();
    await release;
    await unlink(stagedPath);
  });
  const record = recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, nextGeneration, binding, "current-request"
  );
  await started;
  let readSettled = false;

  // When
  const read = readPendingAuthoritativeNativeDeliveries(repository, 10, binding, nextGeneration)
    .finally(() => { readSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeRelease = readSettled;
  releasePublication?.();

  // Then
  expect(settledBeforeRelease).toBe(false);
  await expect(record).resolves.toBeUndefined();
  await expect(read).resolves.toHaveLength(envelope.events.length);
});

it("serializes reads behind a live intent replacement", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-replacement-race");
  const repository = rootRepository(fixture.root);
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending === undefined) throw new IntentConcurrencyFixtureError("pending delivery is missing");
  let replacementStarted: (() => void) | undefined;
  let releaseReplacement: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { replacementStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  const originalReplace = recordStorage.replaceReviewRecord;
  let paused = false;
  vi.spyOn(recordStorage, "replaceReviewRecord").mockImplementation(async (publication) => {
    if (paused || !publication.stagingRoot.endsWith("/intent-staging")) return originalReplace(publication);
    paused = true;
    const stagedPath = join(publication.stagingRoot, `${basename(publication.path)}.${randomUUID()}.tmp`);
    await writeDurable(stagedPath, publication.serialized);
    replacementStarted?.();
    await release;
    await rename(stagedPath, publication.path);
  });
  const supersede = supersedeAuthoritativeNativeDelivery(repository, pending, binding, 409, 10_000);
  await started;
  let readSettled = false;

  // When
  const read = readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId)
    .finally(() => { readSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeRelease = readSettled;
  releaseReplacement?.();

  // Then
  expect(settledBeforeRelease).toBe(false);
  await expect(supersede).resolves.toBeUndefined();
  await expect(read).resolves.not.toContainEqual(expect.objectContaining({ event: pending.event }));
});

async function writeDurable(path: string, serialized: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(serialized, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

class IntentConcurrencyFixtureError extends Error {
  readonly name = "IntentConcurrencyFixtureError";
}
