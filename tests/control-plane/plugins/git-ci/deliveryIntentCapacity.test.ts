import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { recordExplicitAuthoritativeNativeDeliveryIntent } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import type { AuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-ci/src/plan-schema.js";

vi.mock("../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-capacity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-capacity.js")>();
  return { ...actual, DeliveryIntentCatalogCapacity: class extends actual.DeliveryIntentCatalogCapacity {
    constructor() { super(2, 1024 * 1024); }
  } };
});

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");

type CapacityFixture = {
  readonly repository: string;
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly before: readonly { readonly name: string; readonly content: string }[];
};
const ready = Promise.withResolvers<CapacityFixture>();
beforeAll(async () => {
  const fixture = await nativeBundleReviewFixture("intent-verified-capacity");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new IntentCapacityFixtureError("review envelope is missing");
  await closeFinalizeService(fixture.service);
  expect(envelope.events).toHaveLength(2);
  const before = await intentRecords(repository);
  expect(before).toHaveLength(2);
  ready.resolve({ repository, envelope, before });
}, 30_000);
afterAll(cleanupFinalizeFixtures);

it("rejects an entire novel intent batch that crosses the verified catalog quota", async () => {
  // Given
  const { repository, envelope, before } = await ready.promise;

  // When / Then
  await expect(recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, "b".repeat(64), binding, "capacity-crossing-request"
  )).rejects.toThrow("capacity");
  expect(await intentRecords(repository)).toEqual(before);
});

it("accepts an exact duplicate verified intent batch at quota without rewriting state", async () => {
  // Given
  const { repository, envelope, before } = await ready.promise;

  // When
  const duplicate = recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, generationId, binding, "duplicate-at-capacity"
  );

  // Then
  await expect(duplicate).resolves.toBeUndefined();
  expect(await intentRecords(repository)).toEqual(before);
});

async function intentRecords(repository: string): Promise<readonly { readonly name: string; readonly content: string }[]> {
  const root = intentsRoot(repository);
  return Promise.all((await readdir(root)).sort().map(async (name) => ({ name, content: await readFile(join(root, name), "utf8") })));
}

function intentsRoot(repository: string): string {
  return join(repository, "dim-git-ci-deliveries", "intents");
}

class IntentCapacityFixtureError extends Error {
  readonly name = "IntentCapacityFixtureError";
}
