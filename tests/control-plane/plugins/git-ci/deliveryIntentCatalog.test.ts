import { createHash } from "node:crypto";
import { copyFile, open, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/gs/ci/src/authoritative-native-delivery-binding.js";
import {
  readSelectableDeliveryIntents,
  recordExplicitAuthoritativeNativeDeliveryIntent
} from "../../../../packages/gs/ci/src/authoritative-native-delivery-intent-store.js";
import { deliveryIntentKey, deliveryIntentSchema } from "../../../../packages/gs/ci/src/delivery-intent-record.js";
import { readPendingAuthoritativeNativeDeliveries } from "../../../../packages/gs/ci/src/authoritative-native-delivery-store.js";
import * as planStore from "../../../../packages/gs/ci/src/plan-store.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { authoritativePolicy } from "../git-repositories/authoritativeNativeCandidateFixture.js";
import { DeliveryIntentCatalogCapacity } from "../../../../packages/gs/ci/src/delivery-intent-catalog-capacity.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("bounds total catalog entries and encoded bytes across repositories", () => {
  // Given
  const capacity = new DeliveryIntentCatalogCapacity(2, 10);
  capacity.replace(undefined, 4);
  capacity.replace(undefined, 6);

  // When / Then
  expect(() => capacity.replace(undefined, 0)).toThrow(/capacity/i);
  expect(() => capacity.replace(4, 5)).toThrow(/capacity/i);
  expect(() => capacity.replace(6, 5)).not.toThrow();
});

it("reuses a verified intent catalog across large inactive history", async () => {
  // Given
  const repository = await mkdtemp(join(tmpdir(), "dim-intent-catalog-"));
  roots.push(repository);
  const directory = join(repository, "dim-git-ci-deliveries", "intents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const currentGeneration = "a".repeat(64);
  for (let index = 0; index < 400; index += 1) {
    const state = index < 100
      ? { state: "completed" as const, executionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }
      : index < 200
        ? { state: "superseded" as const, rejectionStatus: 409 as const, rejectedAt: 1, retryAfter: 10_000 }
        : { state: "pending" as const };
    const intent = deliveryIntentSchema.parse({
      schemaVersion: 1,
      ...state,
      eventId: digest(`event-${String(index)}`),
      eventDigest: `sha256:${digest(`event-body-${String(index)}`)}`,
      reviewId: digest(`review-${String(index)}`),
      envelopeId: digest(`envelope-${String(index)}`),
      generationId: index < 300 ? currentGeneration : "b".repeat(64),
      serviceId: index >= 250 ? binding.serviceId : "foreign",
      destinationDigest: index >= 250 && index < 300
        ? `sha256:${"f".repeat(64)}`
        : binding.destinationDigest,
      ownerRequestId: `request-${String(index)}`
    });
    await writeFile(join(directory, `${deliveryIntentKey(intent)}.json`), `${JSON.stringify(intent)}\n`, { mode: 0o600 });
  }
  const handle = await open(join(directory, `${deliveryIntentKey(deliveryIntentSchema.parse({
    schemaVersion: 1,
    state: "pending",
    eventId: digest("event-0"),
    eventDigest: `sha256:${digest("event-body-0")}`,
    reviewId: digest("review-0"),
    envelopeId: digest("envelope-0"),
    generationId: currentGeneration,
    serviceId: "foreign",
    destinationDigest: binding.destinationDigest,
    ownerRequestId: "probe"
  }))}.json`), "r").catch(() => open(directory, "r"));
  const readFile = vi.spyOn(Object.getPrototypeOf(handle), "readFile");
  const compareNames = vi.spyOn(String.prototype, "localeCompare");
  await handle.close();

  // When
  const cold = await readSelectableDeliveryIntents(directory, binding, currentGeneration, 5_000);
  const readsAfterCold = readFile.mock.calls.length;
  compareNames.mockClear();
  const warm = await readSelectableDeliveryIntents(directory, binding, currentGeneration, 5_000);

  // Then
  expect(cold).toEqual([]);
  expect(warm).toEqual([]);
  expect(readsAfterCold).toBe(400);
  expect(readFile).toHaveBeenCalledTimes(readsAfterCold);
  expect(compareNames.mock.calls.length).toBeLessThan(10);
}, 30_000);

it("rejects a replaced intent directory instead of trusting the watched inode", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-catalog-directory-replacement");
  const repository = rootRepository(fixture.root);
  await closeFinalizeService(fixture.service);
  await readPendingAuthoritativeNativeDeliveries(repository, 1, binding, generationId);
  const intents = join(repository, "dim-git-ci-deliveries", "intents");
  const displaced = `${intents}.displaced`;
  await rename(intents, displaced);
  await mkdir(intents, { mode: 0o700 });
  for (const name of await readdir(displaced)) {
    await copyFile(join(displaced, name), join(intents, name));
  }

  // When / Then
  await expect(readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, generationId
  )).rejects.toThrow(/directory.*changed|replaced/i);
}, 30_000);

it("rereads the selected canonical intent before returning it for network delivery", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("intent-catalog-selected-reread");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new IntentCatalogFixtureError("review envelope is missing");
  await closeFinalizeService(fixture.service);
  const nextGeneration = "b".repeat(64);
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, nextGeneration, binding, "selected-reread"
  );
  const originalReadProjection = planStore.readVerifiedGitCiDeliveryProjection;
  let changed = false;
  vi.spyOn(planStore, "readVerifiedGitCiDeliveryProjection")
    .mockImplementation(async (targetRepository, source) => {
      const projection = await originalReadProjection(targetRepository, source);
      if (!changed) {
        changed = true;
        const intentDirectory = join(repository, "dim-git-ci-deliveries", "intents");
        for (const name of await readdir(intentDirectory)) {
          const path = join(intentDirectory, name);
          const value: unknown = JSON.parse(await readFile(path, "utf8"));
          const intent = deliveryIntentSchema.parse(value);
          if (intent.generationId !== nextGeneration) continue;
          await writeFile(path, `${JSON.stringify({ ...intent, state: "completed",
            executionId: "00000000-0000-4000-8000-000000000001" })}\n`, { mode: 0o600 });
        }
      }
      return projection;
    });

  // When / Then
  await expect(readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, nextGeneration
  )).rejects.toThrow(/intent changed/i);
}, 30_000);

it("reads one verified projection per poll without warm body rereads for a multijob backlog", async () => {
  // Given
  const jobNames = Array.from({ length: 32 }, (_, index) => `job-${String(index).padStart(2, "0")}`);
  const runner = `jobs:\n${jobNames.map((name) => `  ${name}:\n    script: .dim/ci/jobs/source.bash`).join("\n")}\n`;
  const fixture = await nativeBundleReviewFixture(
    "intent-catalog-multijob",
    undefined,
    authoritativePolicy(["owner"], [], jobNames.map((name) => ({
      name,
      kind: "ordinary-sysbox" as const,
      evidenceClass: "candidate-controlled" as const
    }))),
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    runner
  );
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined || envelope.events.length !== jobNames.length) {
    throw new IntentCatalogFixtureError("multijob review envelope is missing");
  }
  await closeFinalizeService(fixture.service);
  const nextGeneration = "b".repeat(64);
  await recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, nextGeneration, binding, "multijob-request"
  );
  const readProjection = vi.spyOn(planStore, "readVerifiedGitCiDeliveryProjection");
  const planName = (await readdir(join(repository, "dim-git-ci-plans")))[0];
  if (planName === undefined) throw new IntentCatalogFixtureError("Git CI plan is missing");
  const planHandle = await open(join(repository, "dim-git-ci-plans", planName), "r");
  const readBody = vi.spyOn(Object.getPrototypeOf(planHandle), "readFile");
  await planHandle.close();

  // When
  const cold = await readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, nextGeneration
  );
  const projectionReadsAfterCold = readProjection.mock.calls.length;
  const bodyReadsAfterCold = readBody.mock.calls.length;
  const warm = await readPendingAuthoritativeNativeDeliveries(
    repository, 1, binding, nextGeneration
  );

  // Then
  expect(cold).toHaveLength(1);
  expect(warm).toEqual(cold);
  expect(projectionReadsAfterCold).toBe(1);
  expect(readProjection).toHaveBeenCalledTimes(2);
  expect(readBody).toHaveBeenCalledTimes(bodyReadsAfterCold + 1);
  expect(cold[0]?.event.jobName).toBe(
    [...envelope.events].sort((left, right) => left.jobName.localeCompare(right.jobName))[0]?.jobName
  );
}, 30_000);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class IntentCatalogFixtureError extends Error {
  readonly name = "IntentCatalogFixtureError";
}
