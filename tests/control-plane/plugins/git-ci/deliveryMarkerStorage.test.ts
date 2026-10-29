import { createHash, randomUUID } from "node:crypto";
import { access, link, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/gs/ci/src/authoritative-native-delivery-binding.js";
import {
  acknowledgeAuthoritativeNativeDelivery,
  auditAuthoritativeNativeDeliveryOutbox,
  readPendingAuthoritativeNativeDeliveries,
  recordExplicitAuthoritativeNativeDeliveryIntent,
  supersedeAuthoritativeNativeDelivery
} from "../../../../packages/gs/ci/src/authoritative-native-delivery-store.js";
import type { CiDeliveryPublicationFaults } from "../../../../packages/gs/ci/src/delivery-publication.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import {
  closeFinalizeService,
  cleanupFinalizeFixtures,
  generationId,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");

afterEach(cleanupFinalizeFixtures);

it.each(["beforeFileSync", "beforePublish"] as const)(
  "serializes marker reads behind completion paused at %s",
  async (faultPoint) => {
    // Given
    const fixture = await nativeBundleReviewFixture(`marker-${faultPoint}`);
    const repository = rootRepository(fixture.root);
    const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
    if (pending === undefined) throw new MarkerStorageFixtureError("pending delivery is missing");
    const gate = pauseGate();
    const completion = acknowledgeAuthoritativeNativeDelivery(
      repository,
      pending,
      { serviceId: binding.serviceId, generationId, executionId: randomUUID() },
      binding,
      publicationFault(faultPoint, gate)
    );
    await gate.entered;

    // When
    const read = readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);
    const readOutcome = read.then(
      (value) => ({ ok: true, value } as const),
      (error: unknown) => ({ ok: false, error } as const)
    );
    const state = await Promise.race([
      readOutcome.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 250))
    ]);
    gate.release();
    const completed = await completion;
    const observed = await readOutcome;

    // Then
    expect(state).toBe("pending");
    expect(completed).toMatchObject({ state: "recorded", eventId: pending.event.eventId });
    if (!observed.ok) throw observed.error;
    expect(observed.value).not.toContainEqual(expect.objectContaining({ event: pending.event }));
  },
  30_000
);

it("records a rejection only in the current intent without publishing a marker", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-supersession");
  const repository = rootRepository(fixture.root);
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending === undefined) throw new MarkerStorageFixtureError("pending delivery is missing");

  // When
  await supersedeAuthoritativeNativeDelivery(repository, pending, binding, 409, 10_000);

  // Then
  await expect(access(join(deliveredRoot(repository), `${pending.event.eventId}.json`)))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))
    .some(({ event }) => event.eventId === pending.event.eventId)).toBe(false);
}, 30_000);

it("accepts a deployed generationless superseded marker at startup without blocking a fresh generation intent", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-legacy-superseded");
  const repository = rootRepository(fixture.root);
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (pending === undefined || envelope === undefined) {
    throw new MarkerStorageFixtureError("legacy marker fixture is missing");
  }
  await closeFinalizeService(fixture.service);
  const legacyMarkerPath = join(deliveredRoot(repository), `${pending.event.eventId}.json`);
  await writeFile(legacyMarkerPath, `${JSON.stringify({
    schemaVersion: 3,
    state: "superseded",
    eventId: pending.event.eventId,
    eventDigest: pending.eventDigest,
    serviceId: binding.serviceId,
    destinationDigest: binding.destinationDigest,
    rejectionStatus: 409,
    rejectedAt: 1,
    retryAfter: Date.now() + 60_000
  })}\n`, { mode: 0o600 });
  await link(legacyMarkerPath, join(stagingRoot(repository),
    `${basename(legacyMarkerPath)}.${randomUUID()}.tmp`));
  const nextGeneration = "b".repeat(64);
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, nextGeneration, binding, "legacy-marker-next-generation"
  );

  // When
  await auditAuthoritativeNativeDeliveryOutbox(repository, binding, nextGeneration);
  const current = await readPendingAuthoritativeNativeDeliveries(
    repository, 10, binding, nextGeneration
  );

  // Then
  expect(current.some(({ event }) => event.eventId === pending.event.eventId)).toBe(true);
  expect(await readdir(stagingRoot(repository))).toEqual([]);
}, 30_000);

it.each(["orphan", "digest"] as const)(
  "fails the startup audit for a marker with invalid %s provenance",
  async (invalidPart) => {
    // Given
    const fixture = await nativeBundleReviewFixture(`marker-audit-${invalidPart}`);
    const repository = rootRepository(fixture.root);
    const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
    if (pending === undefined) throw new MarkerStorageFixtureError("audit marker fixture is missing");
    await closeFinalizeService(fixture.service);
    const eventId = invalidPart === "orphan" ? "f".repeat(64) : pending.event.eventId;
    await writeFile(join(deliveredRoot(repository), `${eventId}.json`), `${JSON.stringify({
      schemaVersion: 3,
      state: "recorded",
      eventId,
      eventDigest: invalidPart === "digest" ? `sha256:${"f".repeat(64)}` : pending.eventDigest,
      serviceId: binding.serviceId,
      generationId,
      destinationDigest: binding.destinationDigest,
      executionId: randomUUID()
    })}\n`, { mode: 0o600 });

    // When / Then
    await expect(auditAuthoritativeNativeDeliveryOutbox(repository, binding, generationId))
      .rejects.toThrow(/marker|event/i);
  },
  30_000
);

it("discards an uncommitted marker replacement while preserving the canonical completion", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-replacement-restart");
  const repository = rootRepository(fixture.root);
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending === undefined) throw new MarkerStorageFixtureError("pending delivery is missing");
  const canonical = await acknowledgeAuthoritativeNativeDelivery(
    repository,
    pending,
    { serviceId: binding.serviceId, generationId, executionId: randomUUID() },
    binding
  );
  const markerPath = join(deliveredRoot(repository), `${pending.event.eventId}.json`);
  const stagedPath = join(stagingRoot(repository), `${basename(markerPath)}.${randomUUID()}.tmp`);
  await writeDurable(stagedPath, `${JSON.stringify({ ...canonical, generationId: "b".repeat(64), executionId: randomUUID() })}\n`);

  // When
  const recovered = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);

  // Then
  expect(recovered.some(({ event }) => event.eventId === pending.event.eventId)).toBe(false);
  expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(canonical);
  expect(await readdir(stagingRoot(repository))).toEqual([]);
  await expect(open(stagedPath, "r")).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("serializes marker quota admission and still permits an existing event replacement at capacity", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-capacity");
  const repository = rootRepository(fixture.root);
  const pending = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);
  const first = pending[0];
  const second = pending[1];
  if (first === undefined || second === undefined) {
    throw new MarkerStorageFixtureError("two pending deliveries are required");
  }
  const deliveries = [first, second] as const;
  await closeFinalizeService(fixture.service);
  await fillCapacity(repository, new Set(deliveries.map(({ event }) => event.eventId)), 99_999);

  // When
  const outcomes = await Promise.allSettled(deliveries.map((delivery) => acknowledgeAuthoritativeNativeDelivery(
    repository,
    delivery,
    { serviceId: binding.serviceId, generationId, executionId: randomUUID() },
    binding
  )));

  // Then
  expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(await readdir(deliveredRoot(repository))).toHaveLength(100_000);
  const acceptedIndex = outcomes.findIndex(({ status }) => status === "fulfilled");
  const accepted = deliveries[acceptedIndex];
  if (accepted === undefined) throw new MarkerStorageFixtureError("accepted delivery is missing");
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new MarkerStorageFixtureError("review envelope is missing");
  const nextGeneration = "b".repeat(64);
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, nextGeneration, binding, "marker-capacity-replacement"
  );
  const replacement = (await readPendingAuthoritativeNativeDeliveries(
    repository, 10, binding, nextGeneration
  )).find(({ event }) => event.eventId === accepted.event.eventId);
  if (replacement === undefined) throw new MarkerStorageFixtureError("replacement delivery is missing");
  await expect(acknowledgeAuthoritativeNativeDelivery(repository, replacement,
    { serviceId: binding.serviceId, generationId: nextGeneration, executionId: randomUUID() }, binding))
    .resolves.toMatchObject({ eventId: accepted.event.eventId });
  expect(await readdir(deliveredRoot(repository))).toHaveLength(100_000);
}, 30_000);

function pauseGate(): {
  readonly entered: Promise<void>;
  readonly pause: () => Promise<void>;
  readonly release: () => void;
} {
  let enter: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  return { entered, pause: async () => { enter?.(); await paused; }, release: () => { resume?.(); } };
}

function publicationFault(
  point: "beforeFileSync" | "beforePublish",
  gate: ReturnType<typeof pauseGate>
): CiDeliveryPublicationFaults {
  return point === "beforeFileSync" ? { beforeFileSync: gate.pause } : { beforePublish: gate.pause };
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

async function fillCapacity(repository: string, excluded: ReadonlySet<string>, target: number): Promise<void> {
  const directory = deliveredRoot(repository);
  const names: string[] = [];
  for (let index = 0; names.length < target; index += 1) {
    const name = createHash("sha256").update(`marker-capacity-${String(index)}`).digest("hex");
    if (!excluded.has(name)) names.push(name);
  }
  const firstSeed = join(directory, `${names[0]}.json`);
  const secondSeed = join(directory, `${names[1]}.json`);
  await writeFile(firstSeed, "{}\n", { mode: 0o600 });
  await writeFile(secondSeed, "{}\n", { mode: 0o600 });
  for (let index = 2; index < names.length; index += 500) {
    await Promise.all(names.slice(index, index + 500).map((name, offset) =>
      link((index + offset) % 2 === 0 ? firstSeed : secondSeed, join(directory, `${name}.json`))));
  }
}

function deliveredRoot(repository: string): string {
  return join(repository, "dim-git-ci-deliveries", "delivered");
}

function stagingRoot(repository: string): string {
  return join(repository, "dim-git-ci-deliveries", "delivery-staging");
}

class MarkerStorageFixtureError extends Error {
  readonly name = "MarkerStorageFixtureError";
}
