import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { dimDeliveryBinding as authoritativeNativeDeliveryBinding } from "../../../support/dimCi.js";
import { readPendingAuthoritativeNativeDeliveries, recordExplicitAuthoritativeNativeDeliveryIntent,
  supersedeAuthoritativeNativeDelivery } from "../../../../packages/gs/ci/src/authoritative-native-delivery-store.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, closeFinalizeService, generationId, rootRepository } from "../git-repositories/nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

it("rejects lost known outbox storage before recreating it or resetting rejection backoff", async () => {
  const fixture = await nativeBundleReviewFixture("intent-store-loss");
  const repository = rootRepository(fixture.root);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (envelope === undefined) throw new Error("fixture envelope is missing");
  await closeFinalizeService(fixture.service);
  const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
  const delivery = (await readPendingAuthoritativeNativeDeliveries(repository, 1, binding, generationId))[0];
  if (delivery === undefined) throw new Error("fixture delivery is missing");
  await supersedeAuthoritativeNativeDelivery(repository, delivery, binding, 409, 60_000);
  const root = join(repository, "dim-git-ci-deliveries");
  await rm(root, { recursive: true, force: true });

  await expect(recordExplicitAuthoritativeNativeDeliveryIntent(
    repository, envelope, generationId, binding, "retry-after-store-loss"
  )).rejects.toThrow(/missing|disappeared|known|lost/i);
  await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
});
