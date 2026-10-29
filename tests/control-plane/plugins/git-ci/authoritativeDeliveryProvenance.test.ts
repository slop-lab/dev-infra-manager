import { randomUUID } from "node:crypto";
import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createAuthoritativeNativeReviewEnvelope,
  readAuthoritativeNativeReviewEnvelopes,
  saveAuthoritativeNativeReviewEnvelope
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { authoritativeNativeDeliveryBinding } from "../../../../packages/gs/ci/src/authoritative-native-delivery-binding.js";
import {
  acknowledgeAuthoritativeNativeDelivery,
  auditAuthoritativeNativeDeliveryOutbox,
  AuthoritativeNativeDeliveryStoreError,
  readPendingAuthoritativeNativeDeliveries
} from "../../../../packages/gs/ci/src/authoritative-native-delivery-store.js";
import { nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  generationId,
  rootRepository
} from "../git-repositories/nativeRootImportFinalizeFixture.js";

const binding = authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");

afterEach(cleanupFinalizeFixtures);

it("selects the exact CI envelope across canonical review variants and retains the earliest creation time", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("delivery-multi-envelope");
  const repository = rootRepository(fixture.root);
  await closeFinalizeService(fixture.service);
  const canonical = (await readAuthoritativeNativeReviewEnvelopes(repository))[0];
  if (canonical === undefined) throw new DeliveryProvenanceFixtureError("canonical review is missing");
  const { reviewId: _reviewId, createdAt: _createdAt, ...identity } = canonical.review;
  const earlierCreatedAt = "2000-01-01T00:00:00.000Z";
  await saveAuthoritativeNativeReviewEnvelope(repository, createAuthoritativeNativeReviewEnvelope({
    identity,
    policyDigest: canonical.policyDigest,
    attachments: [...canonical.attachments, {
      kind: "test-metadata",
      id: "a".repeat(64),
      digest: "a".repeat(64)
    }],
    createdAt: earlierCreatedAt
  }));

  // When
  const pending = await readPendingAuthoritativeNativeDeliveries(
    repository, 10, binding, generationId
  );

  // Then
  expect(pending).toHaveLength(2);
  expect(pending.every(({ createdAt }) => createdAt === earlierCreatedAt)).toBe(true);
  expect(pending.every(({ event, intent }) => event.envelopeId === intent.envelopeId)).toBe(true);
  expect(pending.every(({ event }) => event.envelopeId !== canonical.envelopeId)).toBe(true);
  expect(pending.every(({ provenance }) => provenance.sourceVersions.length === 2)).toBe(true);
}, 30_000);

it("rejects a changed canonical intent before publishing its acknowledgement marker", async () => {
  // Given
  const fixture = await nativeBundleReviewFixture("delivery-intent-reread");
  const repository = rootRepository(fixture.root);
  const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
  if (pending === undefined) throw new DeliveryProvenanceFixtureError("pending delivery is missing");
  await closeFinalizeService(fixture.service);
  const intentPath = await findIntentPath(repository, pending.event.eventId);
  await writeFile(intentPath, `${JSON.stringify({ ...pending.intent, state: "completed", executionId: randomUUID() })}\n`, {
    mode: 0o600
  });

  // When / Then
  await expect(acknowledgeAuthoritativeNativeDelivery(repository, pending, {
    serviceId: binding.serviceId,
    generationId,
    executionId: randomUUID()
  }, binding)).rejects.toThrow(/intent changed/i);
  await expect(access(markerPath(repository, pending.event.eventId))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it.each(["review", "plan"] as const)(
  "rejects a changed verified %s before publishing its acknowledgement marker",
  async (recordKind) => {
    // Given
    const fixture = await nativeBundleReviewFixture(`delivery-${recordKind}-reread`);
    const repository = rootRepository(fixture.root);
    const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
    if (pending === undefined) throw new DeliveryProvenanceFixtureError("pending delivery is missing");
    await closeFinalizeService(fixture.service);
    if (recordKind === "review") {
      const directory = join(repository, "dim-authoritative-reviews", "proposals");
      const name = (await readdir(directory)).sort()[0];
      if (name === undefined) throw new DeliveryProvenanceFixtureError("review record is missing");
      const path = join(directory, name);
      const replacement = `${path}.replacement`;
      await writeFile(replacement, await readFile(path), { mode: 0o600 });
      await rename(replacement, path);
    } else {
      const directory = join(repository, "dim-git-ci-plans");
      const name = (await readdir(directory)).sort()[0];
      if (name === undefined) throw new DeliveryProvenanceFixtureError("plan record is missing");
      await writeFile(join(directory, name), "{}\n", { mode: 0o600 });
    }

    // When / Then
    await expect(acknowledgeAuthoritativeNativeDelivery(repository, pending, {
      serviceId: binding.serviceId,
      generationId,
      executionId: randomUUID()
    }, binding)).rejects.toThrow(/changed|plan|version/i);
    await expect(access(markerPath(repository, pending.event.eventId))).rejects.toMatchObject({ code: "ENOENT" });
  },
  30_000
);

it.each(["pending-lookup", "startup-audit"] as const)(
  "rejects a missing canonical history instead of hiding durable outbox state during %s",
  async (operation) => {
    // Given durable delivery metadata whose canonical history subsequently disappears.
    const fixture = await nativeBundleReviewFixture(`delivery-missing-history-${operation}`);
    const repository = rootRepository(fixture.root);
    const pending = (await readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId))[0];
    if (pending === undefined) throw new DeliveryProvenanceFixtureError("pending delivery is missing");
    await closeFinalizeService(fixture.service);
    if (operation === "startup-audit") await acknowledgeAuthoritativeNativeDelivery(repository, pending, {
      serviceId: binding.serviceId, generationId, executionId: randomUUID()
    }, binding);
    const canonical = join(repository, "dim-authoritative-reviews"), displaced = `${canonical}.displaced`;
    await rename(canonical, displaced);
    try {
      // When the owner discovers pending work or audits its stored receipts.
      const reading = operation === "pending-lookup"
        ? readPendingAuthoritativeNativeDeliveries(repository, 10, binding, generationId)
        : auditAuthoritativeNativeDeliveryOutbox(repository, binding, generationId);
      // Then missing provenance is a failure, not an empty authoritative outbox.
      await expect(reading).rejects.toBeInstanceOf(AuthoritativeNativeDeliveryStoreError);
    } finally { await rename(displaced, canonical); }
  },
  30_000
);

async function findIntentPath(repository: string, eventId: string): Promise<string> {
  const directory = join(repository, "dim-git-ci-deliveries", "intents");
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)
      && Reflect.get(value, "eventId") === eventId) return path;
  }
  throw new DeliveryProvenanceFixtureError("intent record is missing");
}

function markerPath(repository: string, eventId: string): string {
  return join(repository, "dim-git-ci-deliveries", "delivered", `${eventId}.json`);
}

class DeliveryProvenanceFixtureError extends Error {
  readonly name = "DeliveryProvenanceFixtureError";
}
