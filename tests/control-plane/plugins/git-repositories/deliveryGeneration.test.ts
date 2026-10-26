import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { acknowledgeAuthoritativeNativeDelivery, readPendingAuthoritativeNativeDeliveries,
  recordExplicitAuthoritativeNativeDeliveryIntent, supersedeAuthoritativeNativeDelivery } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "../git-ci/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId, rootRepository } from "./nativeRootImportFinalizeFixture.js";
afterEach(cleanupFinalizeFixtures);
it("preserves completed delivery deduplication across generation replacement while retaining destination binding", async () => {
  const fixture = await nativeBundleReviewFixture("delivery-generation");
  const repository = rootRepository(fixture.root), binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
  const pending = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId);
  expect(pending.map((job) => job.event.executionKind).sort()).toEqual(["ordinary-sysbox", "qemu"]);
  const job = pending[0]!;
  await acknowledgeAuthoritativeNativeDelivery(repository, job, { serviceId: "ci", generationId, executionId: randomUUID() }, binding);
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))
    .some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(false);
  const afterRollover = await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64));
  expect(afterRollover.some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(false);
  expect(afterRollover).toHaveLength(pending.length - 1);
  const envelope = (await publishedReviewEnvelopes(fixture.root))[0];
  if (!envelope) throw new Error("review envelope is missing");
  const foreignBinding = authoritativeNativeDeliveryBinding("ci", "http://foreign:8080/v1/jobs");
  await recordExplicitAuthoritativeNativeDeliveryIntent(repository, envelope, "b".repeat(64), foreignBinding, "foreign-request");
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64)))
    .some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(false);
  await recordExplicitAuthoritativeNativeDeliveryIntent(repository, envelope, "b".repeat(64), binding, "request-one");
  await recordExplicitAuthoritativeNativeDeliveryIntent(repository, envelope, "b".repeat(64), binding, "request-two");
  const explicit = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64)))
    .filter((candidate) => candidate.event.eventId === job.event.eventId);
  expect(explicit).toHaveLength(1);
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64)))
    .filter((candidate) => candidate.event.eventId === job.event.eventId)).toHaveLength(1);
  await supersedeAuthoritativeNativeDelivery(repository, explicit[0]!, binding, 409, 10_000);
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64)))
    .some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(false);
  const retry = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64), Date.now() + 10_001))
    .find((candidate) => candidate.event.eventId === job.event.eventId);
  if (!retry) throw new Error("explicit delivery retry is missing");
  await acknowledgeAuthoritativeNativeDelivery(repository, retry, { serviceId: "ci", generationId: "b".repeat(64), executionId: randomUUID() }, binding);
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, "b".repeat(64)))
    .some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(false);
  const replacedDestination = authoritativeNativeDeliveryBinding("ci", "http://replacement:8080/v1/jobs");
  expect((await readPendingAuthoritativeNativeDeliveries(repository, 10, replacedDestination, "b".repeat(64)))
    .some((candidate) => candidate.event.eventId === job.event.eventId)).toBe(true);
});
