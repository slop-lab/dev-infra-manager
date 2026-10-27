import { createHash } from "node:crypto";
import { link, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { recordExplicitAuthoritativeNativeDeliveryIntent } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");

afterEach(cleanupFinalizeFixtures);

it("rejects an entire novel intent batch that crosses capacity", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-capacity-batch");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new IntentCapacityFixtureError("review envelope is missing");
  await closeFinalizeService(fixture.service);
  const before = await fillIntentCapacity(repository, 99_999);

  // When / Then
  await expect(recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, "b".repeat(64), binding, "capacity-crossing-request"
  )).rejects.toThrow("capacity");
  expect((await readdir(intentsRoot(repository))).sort()).toEqual(before);
}, 60_000);

it("accepts an exact duplicate intent batch at capacity", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-capacity-duplicate");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new IntentCapacityFixtureError("review envelope is missing");
  await closeFinalizeService(fixture.service);
  const before = await fillIntentCapacity(repository, 100_000);

  // When
  const duplicate = recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, generationId, binding, "duplicate-at-capacity"
  );

  // Then
  await expect(duplicate).resolves.toBeUndefined();
  expect((await readdir(intentsRoot(repository))).sort()).toEqual(before);
}, 60_000);

async function fillIntentCapacity(repository: string, target: number): Promise<readonly string[]> {
  const root = intentsRoot(repository);
  const existing = await readdir(root);
  const existingNames = new Set(existing);
  const available: string[] = [];
  for (let index = 0; available.length < target - existing.length; index += 1) {
    const name = `${createHash("sha256").update(`intent-capacity-${String(index)}`).digest("hex")}.json`;
    if (!existingNames.has(name)) available.push(name);
  }
  const firstSeed = join(root, available[0] ?? "");
  const secondSeed = join(root, available[1] ?? "");
  await writeFile(firstSeed, "{}\n", { mode: 0o600 });
  await writeFile(secondSeed, "{}\n", { mode: 0o600 });
  for (let index = 2; index < available.length; index += 500) {
    await Promise.all(available.slice(index, index + 500).map((name, offset) =>
      link((index + offset) % 2 === 0 ? firstSeed : secondSeed, join(root, name))));
  }
  return [...existing, ...available].sort();
}

function intentsRoot(repository: string): string {
  return join(repository, "dim-git-ci-deliveries", "intents");
}

class IntentCapacityFixtureError extends Error {
  readonly name = "IntentCapacityFixtureError";
}
