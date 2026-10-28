import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  initializeCatalogDeliveryIntents,
  readCatalogDeliveryIntents,
  reserveCatalogDeliveryIntentAdditions,
  reserveCatalogDeliveryIntentReplacement
} from "../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog.js";
import {
  publishCatalogDeliveryIntentAdditions,
  replaceCatalogDeliveryIntent
} from "../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-publication.js";
import { readSelectableDeliveryIntents } from "../../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-intent-store.js";
import {
  deliveryIntentKey,
  deliveryIntentSchema,
  type DeliveryIntent
} from "../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-record.js";

vi.mock("../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-capacity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-capacity.js")>();
  return { ...actual, DeliveryIntentCatalogCapacity: class extends actual.DeliveryIntentCatalogCapacity {
    constructor() { super(3, 3_020); }
  } };
});

const roots: string[] = [];
const generationId = "5".repeat(64);
const binding = { serviceId: "ci", destinationDigest: `sha256:${"6".repeat(64)}` } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("owns tiny quota exactly once across absent old expected and unresolved publication outcomes", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "dim-intent-quota-recovery-"));
  roots.push(root);
  const paths = { intents: join(root, "intents"), staging: join(root, "staging") };
  await mkdir(paths.intents, { mode: 0o700 });
  await mkdir(paths.staging, { mode: 0o700 });
  await initializeCatalogDeliveryIntents(paths.intents);
  const absent = candidate("absent");

  // When
  const absentFailure = publishCatalogDeliveryIntentAdditions(paths, [absent], {
    beforePublish() { throw new QuotaRecoveryFault(); }
  });

  // Then
  await expect(absentFailure).rejects.toThrow(QuotaRecoveryFault);
  await expect(access(join(paths.intents, absent.name))).rejects.toMatchObject({ code: "ENOENT" });

  // Given
  const current = candidate("current");
  await publishCatalogDeliveryIntentAdditions(paths, [current]);
  const completed = deliveryIntentSchema.parse({ ...current.intent, state: "completed",
    executionId: "00000000-0000-4000-8000-000000000001" });

  // When
  const oldFailure = replaceCatalogDeliveryIntent({ paths, name: current.name, next: completed,
    order: current.order, faults: { beforePublish() { throw new QuotaRecoveryFault(); } } });

  // Then
  await expect(oldFailure).rejects.toThrow(QuotaRecoveryFault);
  expect(await readCatalogDeliveryIntents(paths.intents)).toEqual([current.intent]);

  // Given
  const retainedAddition = candidate("retained-addition");
  const additionPath = join(paths.intents, retainedAddition.name);

  // When
  const additionFailure = publishCatalogDeliveryIntentAdditions(paths, [retainedAddition], {
    async afterPublish() {
      await writeFile(additionPath, "{\n", { mode: 0o600 });
      throw new QuotaRecoveryFault();
    }
  });

  // Then
  await expect(additionFailure).rejects.toThrow(QuotaRecoveryFault);
  expect(() => reserveCatalogDeliveryIntentAdditions(paths.intents, [retainedAddition]))
    .toThrow(/known|retained|unresolved/i);

  // When
  const replacementFailure = replaceCatalogDeliveryIntent({ paths, name: current.name,
    next: completed, order: current.order, faults: { async afterPublish() {
      await writeFile(join(paths.intents, current.name), "{\n", { mode: 0o600 });
      throw new QuotaRecoveryFault();
    } } });

  // Then
  await expect(replacementFailure).rejects.toThrow(QuotaRecoveryFault);
  expect(() => reserveCatalogDeliveryIntentReplacement(
    paths.intents, current.name, completed, current.order
  )).toThrow(/unresolved/i);
  expect(await readSelectableDeliveryIntents(
    paths.intents, binding, generationId, 1
  )).toEqual([]);

  // When
  await writeFile(additionPath, `${JSON.stringify(retainedAddition.intent)}\n`, { mode: 0o600 });
  await writeFile(join(paths.intents, current.name), `${JSON.stringify(completed)}\n`, { mode: 0o600 });
  const resolved = await readCatalogDeliveryIntents(paths.intents);
  const finalCandidate = candidate("final");
  await publishCatalogDeliveryIntentAdditions(paths, [finalCandidate]);

  // Then
  expect(new Set(resolved.map(({ eventId }) => eventId)))
    .toEqual(new Set([current.intent.eventId, retainedAddition.intent.eventId]));
  expect(await readCatalogDeliveryIntents(paths.intents))
    .toContainEqual(finalCandidate.intent);
});

function candidate(label: string): {
  readonly name: string;
  readonly intent: DeliveryIntent;
  readonly order: { readonly createdAt: string; readonly reviewId: string;
    readonly jobName: string; readonly eventId: string };
} {
  const intent = deliveryIntentSchema.parse({ schemaVersion: 1, state: "pending",
    eventId: digest(`event-${label}`), eventDigest: `sha256:${"2".repeat(64)}`,
    reviewId: "3".repeat(64), envelopeId: "4".repeat(64), generationId,
    serviceId: binding.serviceId, destinationDigest: binding.destinationDigest, ownerRequestId: "x" });
  return { name: `${deliveryIntentKey(intent)}.json`, intent,
    order: { createdAt: "2026-01-01T00:00:00.000Z", reviewId: intent.reviewId,
      jobName: "source", eventId: intent.eventId } };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class QuotaRecoveryFault extends Error {
  readonly name = "QuotaRecoveryFault";
}
