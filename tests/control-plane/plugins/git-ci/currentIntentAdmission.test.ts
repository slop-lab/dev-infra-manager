import { afterEach, expect, it } from "vitest";
import { readPendingAuthoritativeNativeDeliveries } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { nativeBundleReviewFixture, reviewProposalRef } from "./nativeBundleReviewFixture.js";
import { activateFinalizeServiceForGeneration, activationTokenB, cleanupFinalizeFixtures, closeFinalizeService,
  generationB, generationId, humanReviewerAuthorization, rootRepository,
  startFinalizeServiceForGeneration } from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
afterEach(cleanupFinalizeFixtures);

it("keeps unacknowledged old-generation history dormant after a real restart until current explicit resolution", async () => {
  const fixture = await nativeBundleReviewFixture("current-intent-restart"), repository = rootRepository(fixture.root);
  const original = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);
  expect(original).toHaveLength(2);
  await closeFinalizeService(fixture.service);
  const current = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
  await activateFinalizeServiceForGeneration(current.origin, generationB, activationTokenB);

  expect(await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationB)).toEqual([]);
  const resolved = await fetch(`${current.origin}/v1/projects/project-a/repositories/root/reviews/resolve`, {
    method: "POST", headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationB, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, proposalRef: reviewProposalRef }),
  });
  expect(resolved.status).toBe(200); await resolved.body?.cancel();
  const authorized = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationB);
  expect(authorized.map(({ event }) => event.eventId).sort()).toEqual(original.map(({ event }) => event.eventId).sort());
  expect(authorized.every(({ intent }) => intent?.generationId === generationB)).toBe(true);
  await closeFinalizeService(current);
  const restarted = await startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB);
  await activateFinalizeServiceForGeneration(restarted.origin, generationB, activationTokenB);
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationB)).map(({ event }) => event.eventId).sort())
    .toEqual(authorized.map(({ event }) => event.eventId).sort());
}, 30_000);
