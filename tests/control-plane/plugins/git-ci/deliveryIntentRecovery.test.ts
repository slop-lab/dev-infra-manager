import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acknowledgeAuthoritativeNativeDelivery, readPendingAuthoritativeNativeDeliveries, recordExplicitAuthoritativeNativeDeliveryIntent } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, closeFinalizeService, generationId, rootRepository } from "../git-repositories/nativeRootImportFinalizeFixture.js";

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
