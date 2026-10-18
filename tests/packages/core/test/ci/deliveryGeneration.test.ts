import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { acknowledgeAuthoritativeNativeDelivery, readPendingAuthoritativeNativeDeliveries } from "../../../../../core/packages/native-git/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../../core/packages/native-git/src/authoritative-native-delivery-binding.js";
import { nativeBundleReviewFixture } from "../../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId, rootRepository } from "../../../native-git/test/nativeRootImportFinalizeFixture.js";
afterEach(cleanupFinalizeFixtures);
it("redelivers reviewed jobs after generation replacement while preserving idempotent current-generation receipts", async () => {
  const fixture = await nativeBundleReviewFixture("delivery-generation");
  const repository = rootRepository(fixture.root), binding = authoritativeNativeDeliveryBinding("ci", "http://ordinary-ci:8080/v1/jobs");
  const pending = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);
  expect(pending.map((job) => job.event.executionKind).sort()).toEqual(["ordinary-sysbox", "qemu"]);
  const job = pending[0]!;
  await acknowledgeAuthoritativeNativeDelivery(repository, job, { serviceId: "ci", generationId, executionId: randomUUID() }, binding);
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))
    .some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(false);
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64)))
    .some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(true);
});
