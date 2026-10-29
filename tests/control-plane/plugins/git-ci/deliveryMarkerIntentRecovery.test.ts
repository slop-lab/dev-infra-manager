import { randomUUID } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dimDeliveryBinding as authoritativeNativeDeliveryBinding } from "../../../support/dimCi.js";
import {
  auditAuthoritativeNativeDeliveryOutbox,
  readPendingAuthoritativeNativeDeliveries,
  recordExplicitAuthoritativeNativeDeliveryIntent
} from "../../../../packages/gs/ci/src/authoritative-native-delivery-store.js";
import * as intentStore from "../../../../packages/gs/ci/src/authoritative-native-delivery-intent-store.js";
import type { DeliveryIntent } from "../../../../packages/gs/ci/src/authoritative-native-delivery-intent-store.js";
import { deliveryIntentKey, deliveryIntentSchema } from "../../../../packages/gs/ci/src/delivery-intent-record.js";
import * as planStore from "../../../../packages/gs/ci/src/plan-store.js";
import {
  addCandidateCommit,
  nativeBundleReviewFixture,
  publishedReviewEnvelopes,
  reviewProposalRef,
  waitForPublishedReview
} from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  rootRepository,
  runGit
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFinalizeFixtures();
});

it("repairs recorded-marker crash leftovers once without repeating suppressed history projection", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-intent-warm-recovery");
  const repository = rootRepository(fixture.root);
  await addSecondReview(fixture);
  await closeFinalizeService(fixture.service);
  const pending = await readPendingAuthoritativeNativeDeliveries(
    repository, 100, binding, generationId
  );
  expect(new Set(pending.map(({ event }) => event.reviewId)).size).toBe(2);
  expect(pending.length).toBeGreaterThanOrEqual(4);
  const executionIds = new Map<string, string>();
  for (const delivery of pending) {
    const executionId = randomUUID();
    executionIds.set(delivery.event.eventId, executionId);
    await writeRecordedMarker(repository, delivery.intent, executionId);
  }
  const readProjection = vi.spyOn(planStore, "readVerifiedGitCiDeliveryProjection");

  // When
  const first = await readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, generationId
  );
  const projectionReadsAfterRepair = readProjection.mock.calls.length;
  const second = await readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, generationId
  );

  // Then
  expect(first).toEqual([]);
  expect(second).toEqual([]);
  expect(projectionReadsAfterRepair).toBeGreaterThan(0);
  expect(readProjection).toHaveBeenCalledTimes(projectionReadsAfterRepair);
  const intents = await readIntents(repository);
  for (const delivery of pending) {
    const executionId = executionIds.get(delivery.event.eventId);
    if (executionId === undefined) {
      throw new MarkerIntentRecoveryFixtureError("recovered execution ID is missing");
    }
    expect(intents).toContainEqual({
      ...delivery.intent,
      state: "completed",
      executionId
    });
  }
}, 30_000);

it("recovers an interrupted warm marker repair from intent staging on the next initialization", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-intent-interrupted-repair");
  const repository = rootRepository(fixture.root);
  await closeFinalizeService(fixture.service);
  const pending = (await readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, generationId
  ))[0];
  if (pending === undefined) {
    throw new MarkerIntentRecoveryFixtureError("interrupted recovery delivery is missing");
  }
  const executionId = randomUUID();
  await writeRecordedMarker(repository, pending.intent, executionId);
  const completion = vi.spyOn(intentStore, "completeCurrentDeliveryIntent")
    .mockImplementationOnce(async (paths, previous, interruptedExecutionId) => {
      const replacement = deliveryIntentSchema.parse({
        ...previous, state: "completed", executionId: interruptedExecutionId
      });
      const name = `${deliveryIntentKey(previous)}.json.${randomUUID()}.tmp`;
      await writeDurable(join(paths.staging, name), `${JSON.stringify(replacement)}\n`);
      throw new InterruptedMarkerRepairError();
    });
  await expect(readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, generationId
  )).rejects.toThrow(InterruptedMarkerRepairError);
  completion.mockRestore();

  // When
  const recovered = await readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, generationId
  );

  // Then
  expect(recovered.some(({ event }) => event.eventId === pending.event.eventId)).toBe(false);
  expect(await readdir(join(repository, "dim-git-ci-deliveries", "intent-staging"))).toEqual([]);
  expect(await readdir(join(repository, "dim-git-ci-deliveries", "delivery-staging"))).toEqual([]);
  expect(await readIntents(repository)).toContainEqual({
    ...pending.intent, state: "completed", executionId
  });
}, 30_000);

it("startup audit completes only exact current-generation marker and intent pairs", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-intent-startup-recovery");
  const repository = rootRepository(fixture.root);
  await addSecondReview(fixture);
  await closeFinalizeService(fixture.service);
  const pending = await readPendingAuthoritativeNativeDeliveries(
    repository, 100, binding, generationId
  );
  const exact = pending[0];
  const secondExact = pending.find(({ event }) => event.reviewId !== exact?.event.reviewId);
  const mismatches = pending.filter(({ event }) => event.eventId !== exact?.event.eventId
    && event.eventId !== secondExact?.event.eventId);
  const [oldGeneration, otherDestination] = mismatches;
  if (exact === undefined || secondExact === undefined
    || oldGeneration === undefined || otherDestination === undefined) {
    throw new MarkerIntentRecoveryFixtureError("recovery deliveries are missing");
  }
  const envelopes = await publishedReviewEnvelopes(fixture.root);
  const oldEnvelope = envelopes.find(({ envelopeId }) => envelopeId === oldGeneration.intent.envelopeId);
  const otherEnvelope = envelopes.find(({ envelopeId }) => envelopeId === otherDestination.intent.envelopeId);
  if (oldEnvelope === undefined || otherEnvelope === undefined) {
    throw new MarkerIntentRecoveryFixtureError("recovery envelopes are missing");
  }
  const oldGenerationId = "b".repeat(64);
  const otherBinding = authoritativeNativeDeliveryBinding("ci", "http://other-execution:8080/v1/jobs");
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, oldEnvelope, oldGenerationId, binding, "old-generation-recovery"
  );
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, otherEnvelope, generationId, otherBinding, "other-destination-recovery"
  );
  const seededIntents = await readIntents(repository);
  const oldIntent = seededIntents.find((intent) => intent.eventId === oldGeneration.intent.eventId
    && intent.generationId === oldGenerationId);
  const otherIntent = seededIntents.find((intent) => intent.eventId === otherDestination.intent.eventId
    && intent.destinationDigest === otherBinding.destinationDigest);
  if (oldIntent === undefined || otherIntent === undefined) {
    throw new MarkerIntentRecoveryFixtureError("mismatched recovery intents are missing");
  }
  const exactExecutionId = randomUUID();
  const secondExecutionId = randomUUID();
  await writeRecordedMarker(repository, exact.intent, exactExecutionId);
  await writeRecordedMarker(repository, secondExact.intent, secondExecutionId);
  await writeRecordedMarker(repository, oldIntent, randomUUID());
  await writeRecordedMarker(repository, otherIntent, randomUUID());

  // When
  await auditAuthoritativeNativeDeliveryOutbox(repository, binding, generationId);

  // Then
  const intents = await readIntents(repository);
  expect(intents).toContainEqual({
    ...exact.intent,
    state: "completed",
    executionId: exactExecutionId
  });
  expect(intents).toContainEqual({
    ...secondExact.intent,
    state: "completed",
    executionId: secondExecutionId
  });
  expect(intents).toContainEqual(oldIntent);
  expect(intents).toContainEqual(otherIntent);
  expect(intents).toContainEqual(oldGeneration.intent);
  expect(intents).toContainEqual(otherDestination.intent);
  expect(JSON.parse(await readFile(markerPath(repository, oldGeneration.intent.eventId), "utf8")))
    .toMatchObject({ generationId: oldGenerationId });
  expect(JSON.parse(await readFile(markerPath(repository, otherDestination.intent.eventId), "utf8")))
    .toMatchObject({ destinationDigest: otherBinding.destinationDigest });
}, 30_000);

async function addSecondReview(fixture: Awaited<ReturnType<typeof nativeBundleReviewFixture>>): Promise<void> {
  await addCandidateCommit(fixture.clone, "second-review.bin", Buffer.from([1, 2, 3]));
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  const commit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
  await waitForPublishedReview(fixture.root, commit);
  expect(await publishedReviewEnvelopes(fixture.root)).toHaveLength(2);
}

async function writeRecordedMarker(repository: string, intent: DeliveryIntent,
  executionId: string): Promise<void> {
  const serialized = `${JSON.stringify({
    schemaVersion: 3,
    state: "recorded",
    eventId: intent.eventId,
    eventDigest: intent.eventDigest,
    serviceId: intent.serviceId,
    generationId: intent.generationId,
    destinationDigest: intent.destinationDigest,
    executionId
  })}\n`;
  const marker = await open(markerPath(repository, intent.eventId), "wx", 0o600);
  try {
    await marker.writeFile(serialized, "utf8");
    await marker.sync();
  } finally {
    await marker.close();
  }
}

async function writeDurable(path: string, serialized: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(serialized, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readIntents(repository: string): Promise<readonly DeliveryIntent[]> {
  const directory = join(repository, "dim-git-ci-deliveries", "intents");
  return Promise.all((await readdir(directory)).map(async (name) =>
    deliveryIntentSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8")))));
}

function markerPath(repository: string, eventId: string): string {
  return join(repository, "dim-git-ci-deliveries", "delivered", `${eventId}.json`);
}

class MarkerIntentRecoveryFixtureError extends Error {
  readonly name = "MarkerIntentRecoveryFixtureError";
}

class InterruptedMarkerRepairError extends Error {
  readonly name = "InterruptedMarkerRepairError";
}
