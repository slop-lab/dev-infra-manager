import { randomUUID } from "node:crypto";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import {
  acknowledgeAuthoritativeNativeDelivery,
  readPendingAuthoritativeNativeDeliveries,
  supersedeAuthoritativeNativeDelivery
} from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  generationId,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");

afterEach(cleanupFinalizeFixtures);

it("does not read historical review bodies when no intent belongs to the current generation", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("selective-intent-old-generation");
  const repository = rootRepository(fixture.root);
  await closeFinalizeService(fixture.service);
  await corruptFirstReviewBody(repository);

  // When
  const pending = await readPendingAuthoritativeNativeDeliveries(
    repository,
    10,
    binding,
    "b".repeat(64)
  );

  // Then
  expect(pending).toEqual([]);
}, 30_000);

it("does not read historical review bodies when the outbox has no intents", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("selective-intent-idle");
  await closeFinalizeService(fixture.service);
  const repository = await createFinalizeRoot("selective-intent-fresh-empty-store");
  await cp(join(rootRepository(fixture.root), "dim-authoritative-reviews"),
    join(repository, "dim-authoritative-reviews"), { recursive: true });
  await corruptFirstReviewBody(repository);

  // When
  const pending = await readPendingAuthoritativeNativeDeliveries(
    repository, 10, binding, generationId
  );

  // Then
  expect(pending).toEqual([]);
}, 30_000);

it("does not read historical review bodies for completed intents", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("selective-intent-completed");
  const repository = rootRepository(fixture.root);
  const pending = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);
  if (pending.length === 0) throw new SelectiveIntentFixtureError("pending fixture is missing");
  for (const delivery of pending) {
    await acknowledgeAuthoritativeNativeDelivery(repository, delivery, {
      serviceId: binding.serviceId,
      generationId,
      executionId: randomUUID()
    }, binding);
  }
  await closeFinalizeService(fixture.service);
  await corruptFirstReviewBody(repository);

  // When
  const afterCompletion = await readPendingAuthoritativeNativeDeliveries(
    repository, 10, binding, generationId
  );

  // Then
  expect(afterCompletion).toEqual([]);
}, 30_000);

it("does not read historical review bodies for future-suppressed intents", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("selective-intent-superseded");
  const repository = rootRepository(fixture.root);
  const pending = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);
  if (pending.length === 0) throw new SelectiveIntentFixtureError("pending fixture is missing");
  for (const delivery of pending) {
    await supersedeAuthoritativeNativeDelivery(repository, delivery, binding, 409, 60_000);
  }
  await closeFinalizeService(fixture.service);
  await corruptFirstReviewBody(repository);

  // When
  const suppressed = await readPendingAuthoritativeNativeDeliveries(
    repository, 10, binding, generationId
  );

  // Then
  expect(suppressed).toEqual([]);
}, 30_000);

it("validates every small intent record before filtering inactive generations", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("selective-intent-invalid-inactive");
  const repository = rootRepository(fixture.root);
  await closeFinalizeService(fixture.service);
  const intentDirectory = join(repository, "dim-git-ci-deliveries", "intents");
  const intentName = (await readdir(intentDirectory)).sort()[0];
  if (intentName === undefined) throw new SelectiveIntentFixtureError("intent fixture is missing");
  const intentPath = join(intentDirectory, intentName);
  const value: unknown = JSON.parse(await readFile(intentPath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelectiveIntentFixtureError("intent fixture is invalid");
  }
  await writeFile(intentPath, `${JSON.stringify({ ...value, serviceId: "INVALID" })}\n`, { mode: 0o600 });

  // When / Then
  await expect(readPendingAuthoritativeNativeDeliveries(
    repository,
    10,
    binding,
    "b".repeat(64)
  )).rejects.toThrow();
}, 30_000);

async function corruptFirstReviewBody(repository: string): Promise<void> {
  const directory = join(repository, "dim-authoritative-reviews", "proposals");
  const name = (await readdir(directory)).sort()[0];
  if (name === undefined) throw new SelectiveIntentFixtureError("review fixture is missing");
  await writeFile(join(directory, name), "not-json\n", { mode: 0o600 });
}

class SelectiveIntentFixtureError extends Error {
  readonly name = "SelectiveIntentFixtureError";
}
