import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import {
  acknowledgeAuthoritativeNativeDelivery,
  type AuthoritativeNativePendingDelivery,
  readPendingAuthoritativeNativeDeliveries,
  supersedeAuthoritativeNativeDelivery
} from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import type { CiDeliveryPublicationFaults } from "../../../../packages/control-plane/plugins/git-ci/src/delivery-publication.js";
import { nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
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
      directDelivery(pending),
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

it("serializes marker reads behind a supersession paused before publication", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-supersession");
  const repository = rootRepository(fixture.root);
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending === undefined) throw new MarkerStorageFixtureError("pending delivery is missing");
  const gate = pauseGate();
  const supersession = supersedeAuthoritativeNativeDelivery(
    repository, directDelivery(pending), binding, 409, 10_000, { beforePublish: gate.pause }
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
  await supersession;
  const observed = await readOutcome;

  // Then
  expect(state).toBe("pending");
  if (!observed.ok) throw observed.error;
  expect(observed.value).not.toContainEqual(expect.objectContaining({ event: pending.event }));
}, 30_000);

it("discards an uncommitted marker replacement while preserving the canonical completion", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("marker-replacement-restart");
  const repository = rootRepository(fixture.root);
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending === undefined) throw new MarkerStorageFixtureError("pending delivery is missing");
  const canonical = await acknowledgeAuthoritativeNativeDelivery(
    repository,
    directDelivery(pending),
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
  const deliveries = [directDelivery(first), directDelivery(second)] as const;
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
  await expect(acknowledgeAuthoritativeNativeDelivery(repository, accepted,
    { serviceId: binding.serviceId, generationId, executionId: randomUUID() }, binding)).resolves.toMatchObject({
    eventId: accepted.event.eventId
  });
  expect(await readdir(deliveredRoot(repository))).toHaveLength(100_000);
}, 30_000);

function directDelivery(delivery: AuthoritativeNativePendingDelivery): AuthoritativeNativePendingDelivery {
  return {
    createdAt: delivery.createdAt,
    event: delivery.event,
    eventDigest: delivery.eventDigest,
    policyDigest: delivery.policyDigest
  };
}

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
