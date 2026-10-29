import { randomUUID } from "node:crypto";
import { link, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as storage from "../../../../packages/gs/review/src/review-record-storage.js";
import { initializeDeliveryIntentStore, readSelectableDeliveryIntents } from "../../../../packages/gs/ci/src/authoritative-native-delivery-intent-store.js";
import { publishCatalogDeliveryIntentAdditions } from "../../../../packages/gs/ci/src/delivery-intent-catalog-publication.js";
import { readCatalogDeliveryIntents, reserveCatalogDeliveryIntentAdditions } from "../../../../packages/gs/ci/src/delivery-intent-catalog.js";
import { deliveryIntentKey, deliveryIntentSchema } from "../../../../packages/gs/ci/src/delivery-intent-record.js";

vi.mock("../../../../packages/gs/ci/src/delivery-intent-catalog-capacity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/gs/ci/src/delivery-intent-catalog-capacity.js")>();
  return { ...actual, DeliveryIntentCatalogCapacity: class extends actual.DeliveryIntentCatalogCapacity {
    constructor() { super(1, 4096); }
  } };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("resolves a retained post-link record after staging recovery without double-counting quota", async () => {
  const repository = await mkdtemp(join(tmpdir(), "dim-intent-post-link-"));
  roots.push(repository);
  const paths = await initializeDeliveryIntentStore(repository);
  const intent = deliveryIntentSchema.parse({ schemaVersion: 1, state: "pending", eventId: "1".repeat(64),
    eventDigest: `sha256:${"2".repeat(64)}`, reviewId: "3".repeat(64), envelopeId: "4".repeat(64),
    generationId: "5".repeat(64), serviceId: "ci", destinationDigest: `sha256:${"6".repeat(64)}`, ownerRequestId: "post-link" });
  const candidate = { name: `${deliveryIntentKey(intent)}.json`, intent,
    order: { createdAt: "2026-01-01T00:00:00.000Z", reviewId: intent.reviewId, jobName: "source", eventId: intent.eventId } };
  const publication = vi.spyOn(storage, "publishReviewRecord").mockImplementationOnce(async (input) => {
    const staged = join(input.stagingRoot, `${basename(input.path)}.${randomUUID()}.tmp`);
    const file = await open(staged, "wx", 0o600);
    try { await file.writeFile(input.serialized); await file.sync(); }
    finally { await file.close(); }
    await link(staged, input.path);
    throw new PostLinkFault();
  });
  await expect(publishCatalogDeliveryIntentAdditions(paths, [candidate])).rejects.toThrow(PostLinkFault);
  publication.mockRestore();

  await expect(initializeDeliveryIntentStore(repository)).resolves.toEqual(paths);
  expect(await readdir(paths.staging)).toEqual([]);
  expect(await readCatalogDeliveryIntents(paths.intents)).toEqual([intent]);
  expect(await readSelectableDeliveryIntents(paths.intents,
    { serviceId: intent.serviceId, destinationDigest: intent.destinationDigest }, intent.generationId, 1)).toEqual([intent]);
  const other = deliveryIntentSchema.parse({ ...intent, eventId: "7".repeat(64) });
  expect(() => reserveCatalogDeliveryIntentAdditions(paths.intents,
    [{ ...candidate, name: `${deliveryIntentKey(other)}.json`, intent: other }])).toThrow(/capacity/i);
});

class PostLinkFault extends Error { readonly name = "PostLinkFault"; }
