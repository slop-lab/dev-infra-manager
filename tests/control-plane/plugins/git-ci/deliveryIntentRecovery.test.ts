import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acknowledgeAuthoritativeNativeDelivery, readPendingAuthoritativeNativeDeliveries, recordExplicitAuthoritativeNativeDeliveryIntent } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, closeFinalizeService, generationId, rootRepository } from "../git-repositories/nativeRootImportFinalizeFixture.js";
import type { DeliveryIntent } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-intent-store.js";

afterEach(cleanupFinalizeFixtures);
it("recovers published marker and intent hardlinks independently after a disposable service shutdown", async () => {
  const fixture = await nativeBundleReviewFixture("intent-staging-restart"), repository = rootRepository(fixture.root);
  const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (!envelope || !pending) throw new Error("fixture delivery missing");
  await acknowledgeAuthoritativeNativeDelivery(repository, pending, { serviceId: "ci", generationId, executionId: randomUUID() }, binding);
  await closeFinalizeService(fixture.service);
  const nextGeneration = "b".repeat(64);
  await recordExplicitAuthoritativeNativeDeliveryIntent(repository, envelope, nextGeneration, binding, "current-request");
  const root = join(repository, "dim-git-ci-deliveries"), intents = join(root, "intents"), intentStaging = join(root, "intent-staging"), markerStaging = join(root, "delivery-staging");
  await mkdir(intentStaging, { recursive: true, mode: 0o700 });
  let intentFile: string | undefined;
  for (const file of await readdir(intents)) {
    const value: unknown = JSON.parse(await readFile(join(intents, file), "utf8"));
    if (value && typeof value === "object" && "generationId" in value && value.generationId === nextGeneration && "eventId" in value && value.eventId === pending.event.eventId) intentFile = join(intents, file);
  }
  if (!intentFile) throw new Error("fixture intent missing");
  const markerFile = join(root, "delivered", `${pending.event.eventId}.json`);
  await link(intentFile, join(intentStaging, `${basename(intentFile)}.${randomUUID()}.tmp`));
  await link(markerFile, join(markerStaging, `${basename(markerFile)}.${randomUUID()}.tmp`));
  const recovered = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, nextGeneration);
  expect(recovered.some(({ event }) => event.eventId === pending.event.eventId)).toBe(true);
  expect(await readdir(intentStaging)).toEqual([]); expect(await readdir(markerStaging)).toEqual([]);
  expect((await stat(intentFile)).nlink).toBe(1); expect((await stat(markerFile)).nlink).toBe(1);
}, 30_000);

it("discards an uncommitted mutable intent replacement while preserving the canonical record", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-replacement-restart"), repository = rootRepository(fixture.root);
  const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending?.intent === undefined) throw new Error("fixture intent missing");
  const intentPath = await findIntentPath(repository, pending.intent);
  const replacement = { ...pending.intent, state: "superseded", rejectionStatus: 409,
    rejectedAt: 1, retryAfter: 2 } satisfies DeliveryIntent;
  const stagedPath = await writeStagedIntent(repository, intentPath, replacement);

  // When
  const recovered = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);

  // Then
  expect(recovered.some(({ event }) => event.eventId === pending.event.eventId)).toBe(true);
  expect(JSON.parse(await readFile(intentPath, "utf8"))).toEqual(pending.intent);
  expect(await readdir(join(repository, "dim-git-ci-deliveries", "intent-staging"))).toEqual([]);
  await expect(open(stagedPath, "r")).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("rejects an intent replacement staging entry with a changed event identity", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-replacement-tamper"), repository = rootRepository(fixture.root);
  const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending?.intent === undefined) throw new Error("fixture intent missing");
  const intentPath = await findIntentPath(repository, pending.intent);
  const tampered = { ...pending.intent, eventDigest: `sha256:${"f".repeat(64)}` } satisfies DeliveryIntent;
  const stagedPath = await writeStagedIntent(repository, intentPath, tampered);

  // When / Then
  await expect(readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId)).rejects.toThrow();
  expect(JSON.parse(await readFile(intentPath, "utf8"))).toEqual(pending.intent);
  expect(await readdir(join(repository, "dim-git-ci-deliveries", "intent-staging")))
    .toEqual([basename(stagedPath)]);
}, 30_000);

async function findIntentPath(repository: string, expected: DeliveryIntent): Promise<string> {
  const intents = join(repository, "dim-git-ci-deliveries", "intents");
  for (const name of await readdir(intents)) {
    const path = join(intents, name);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value && typeof value === "object" && "eventId" in value && value.eventId === expected.eventId
      && "generationId" in value && value.generationId === expected.generationId) return path;
  }
  throw new Error("fixture intent path missing");
}

async function writeStagedIntent(repository: string, intentPath: string, intent: DeliveryIntent): Promise<string> {
  const staging = join(repository, "dim-git-ci-deliveries", "intent-staging");
  const stagedPath = join(staging, `${basename(intentPath)}.${randomUUID()}.tmp`);
  const file = await open(stagedPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(intent)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  return stagedPath;
}
