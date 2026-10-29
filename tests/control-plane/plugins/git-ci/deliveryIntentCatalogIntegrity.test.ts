import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/gs/ci/src/authoritative-native-delivery-binding.js";
import {
  readSelectableDeliveryIntents,
  readVerifiedDeliveryIntents,
  recordExplicitAuthoritativeNativeDeliveryIntent,
  supersedeCurrentDeliveryIntent,
  withCurrentDeliveryIntent
} from "../../../../packages/gs/ci/src/authoritative-native-delivery-intent-store.js";
import { DeliveryIntentCatalogCapacity } from "../../../../packages/gs/ci/src/delivery-intent-catalog-capacity.js";
import {
  initializeCatalogDeliveryIntents,
  readCatalogDeliveryIntents,
  reserveCatalogDeliveryIntentAdditions
} from "../../../../packages/gs/ci/src/delivery-intent-catalog.js";
import { publishCatalogDeliveryIntentAdditions } from "../../../../packages/gs/ci/src/delivery-intent-catalog-publication.js";
import {
  deliveryIntentKey,
  deliveryIntentSchema,
  type DeliveryIntent
} from "../../../../packages/gs/ci/src/delivery-intent-record.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
const roots: string[] = [];

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("rejects same-name inactive corruption during an explicit catalog audit without notifications", async () => {
  // Given
  const fixture = await intentFixture("inactive-corruption", "completed");
  await readSelectableDeliveryIntents(fixture.intents, binding, fixture.intent.generationId, 1);
  const changed = deliveryIntentSchema.parse({ ...fixture.intent,
    executionId: "00000000-0000-4000-8000-000000000002" });
  await writeFile(fixture.path, `${JSON.stringify(changed)}\n`, { mode: 0o600 });

  // When / Then
  await expect(readVerifiedDeliveryIntents(fixture.intents)).rejects.toThrow(/changed/i);
});

it("rejects a selected byte-identical replacement before publication", async () => {
  // Given
  const fixture = await intentFixture("selected-replacement", "pending");
  await readSelectableDeliveryIntents(fixture.intents, binding, fixture.intent.generationId, 1);
  const serialized = await readFile(fixture.path, "utf8");
  await rename(fixture.path, join(fixture.staging, "replaced"));
  await writeFile(fixture.path, serialized, { mode: 0o600 });

  // When / Then
  await expect(withCurrentDeliveryIntent(
    { intents: fixture.intents, staging: fixture.staging },
    fixture.intent,
    async () => "published"
  )).rejects.toThrow(/changed/i);
});

it("retries a failed reconciliation instead of consuming its unread name", async () => {
  // Given
  const fixture = await intentFixture("sticky-reconciliation", "completed");
  await readSelectableDeliveryIntents(fixture.intents, binding, fixture.intent.generationId, 1);
  const pending = createIntent("sticky-pending", "pending");
  const path = join(fixture.intents, `${deliveryIntentKey(pending)}.json`);
  await writeFile(path, "{\n", { mode: 0o600 });
  await expect(readSelectableDeliveryIntents(
    fixture.intents, binding, pending.generationId, 1
  )).rejects.toThrow();

  // When
  await writeFile(path, `${JSON.stringify(pending)}\n`, { mode: 0o600 });
  const selected = await readSelectableDeliveryIntents(
    fixture.intents, binding, pending.generationId, 1
  );

  // Then
  expect(selected).toEqual([pending]);
});

it("does not republish a deleted superseded intent as pending", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-catalog-deleted-superseded");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new IntentCatalogIntegrityFixtureError("review envelope is missing");
  await closeFinalizeService(fixture.service);
  const generationId = "b".repeat(64);
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, generationId, binding, "deleted-superseded"
  );
  const intents = join(repository, "dim-git-ci-deliveries", "intents");
  const staging = join(repository, "dim-git-ci-deliveries", "intent-staging");
  let selected: { readonly name: string; readonly intent: DeliveryIntent } | undefined;
  for (const name of await readdir(intents)) {
    const value: unknown = JSON.parse(await readFile(join(intents, name), "utf8"));
    const intent = deliveryIntentSchema.parse(value);
    if (intent.generationId === generationId) selected = { name, intent };
  }
  if (selected === undefined) throw new IntentCatalogIntegrityFixtureError("delivery intent is missing");
  const { name, intent: pending } = selected;
  await supersedeCurrentDeliveryIntent({ intents, staging }, pending, 409, 1, 10_000);
  await unlink(join(intents, name));

  // When / Then
  await expect(recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, generationId, binding, "deleted-superseded"
  )).rejects.toThrow(/disappeared|known|changed/i);
});

it("holds the process-wide final catalog slot across concurrent repository publication", async () => {
  // Given
  const capacity = new DeliveryIntentCatalogCapacity(1, 16);
  const firstRepository = capacity.reserve(1, 16);
  let releasePublication: (() => void) | undefined;
  const publication = new Promise<void>((resolve) => { releasePublication = resolve; });
  const firstWrite = publication.then(() => {
    firstRepository.consumeAddition(16);
    firstRepository.release();
  });

  // When / Then
  expect(() => capacity.reserve(1, 16)).toThrow(/capacity/i);
  releasePublication?.();
  await firstWrite;
  expect(() => capacity.reserve(1, 16)).toThrow(/capacity/i);
});

it("releases unused catalog capacity when publication fails before durability", () => {
  // Given
  const capacity = new DeliveryIntentCatalogCapacity(1, 16);
  const failedPublication = capacity.reserve(1, 16);

  // When
  failedPublication.release();

  // Then
  const retry = capacity.reserve(1, 16);
  expect(retry).toBeDefined();
  retry.release();
});

it("retains durable catalog admission when a post-publication hook throws", async () => {
  // Given
  const repository = await mkdtemp(join(tmpdir(), "dim-intent-post-publication-"));
  roots.push(repository);
  const intents = join(repository, "dim-git-ci-deliveries", "intents");
  const staging = join(repository, "dim-git-ci-deliveries", "intent-staging");
  await mkdir(intents, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  await initializeCatalogDeliveryIntents(intents);
  const intent = createIntent("post-publication", "pending");
  const candidate = { name: `${deliveryIntentKey(intent)}.json`, intent,
    order: { createdAt: "2026-10-28T00:00:00.000Z", reviewId: intent.reviewId,
      jobName: "source", eventId: intent.eventId } };

  // When
  const publication = publishCatalogDeliveryIntentAdditions(
    { intents, staging }, [candidate],
    { afterPublish() { throw new IntentCatalogPostPublicationError(); } }
  );

  // Then
  await expect(publication).rejects.toThrow(IntentCatalogPostPublicationError);
  expect(await readCatalogDeliveryIntents(intents)).toEqual([intent]);
  expect(() => reserveCatalogDeliveryIntentAdditions(intents, [candidate])).toThrow(/known/i);
  expect(await readFile(join(intents, candidate.name), "utf8")).toBe(`${JSON.stringify(intent)}\n`);
});

it("rejects a duplicate owner request after byte-identical record replacement", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-catalog-duplicate-replacement");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new IntentCatalogIntegrityFixtureError("review envelope is missing");
  await closeFinalizeService(fixture.service);
  const generationId = "b".repeat(64);
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, generationId, binding, "duplicate-replacement"
  );
  const intents = join(repository, "dim-git-ci-deliveries", "intents");
  let selectedPath: string | undefined;
  for (const name of await readdir(intents)) {
    const path = join(intents, name);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (deliveryIntentSchema.parse(value).generationId === generationId) selectedPath = path;
  }
  if (selectedPath === undefined) throw new IntentCatalogIntegrityFixtureError("delivery intent is missing");
  const serialized = await readFile(selectedPath, "utf8");
  await rename(selectedPath, join(repository, "displaced-intent.json"));
  await writeFile(selectedPath, serialized, { mode: 0o600 });

  // When / Then
  await expect(recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, generationId, binding, "duplicate-replacement"
  )).rejects.toThrow(/changed/i);
});

async function intentFixture(label: string, state: "pending" | "completed"): Promise<{
  readonly intents: string;
  readonly staging: string;
  readonly path: string;
  readonly intent: DeliveryIntent;
}> {
  const repository = await mkdtemp(join(tmpdir(), `dim-intent-integrity-${label}-`));
  roots.push(repository);
  const intents = join(repository, "dim-git-ci-deliveries", "intents");
  const staging = join(repository, "dim-git-ci-deliveries", "intent-staging");
  await mkdir(intents, { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  const intent = createIntent(label, state);
  const path = join(intents, `${deliveryIntentKey(intent)}.json`);
  await writeFile(path, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
  return { intents, staging, path, intent };
}

function createIntent(label: string, state: "pending" | "completed"): DeliveryIntent {
  return deliveryIntentSchema.parse({ schemaVersion: 1,
    ...(state === "pending"
      ? { state }
      : { state, executionId: "00000000-0000-4000-8000-000000000001" }),
    eventId: digest(`event-${label}`), eventDigest: `sha256:${digest(`body-${label}`)}`,
    reviewId: digest(`review-${label}`), envelopeId: digest(`envelope-${label}`),
    generationId: "b".repeat(64), serviceId: binding.serviceId,
    destinationDigest: binding.destinationDigest, ownerRequestId: `request-${label}` });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class IntentCatalogIntegrityFixtureError extends Error {
  readonly name = "IntentCatalogIntegrityFixtureError";
}

class IntentCatalogPostPublicationError extends Error {
  readonly name = "IntentCatalogPostPublicationError";
}
