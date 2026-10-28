import { expect, it } from "vitest";
import { addCatalogEntry, selectableIntentCursor, type CatalogBucket } from "../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-catalog-index.js";
import { deliveryIntentSchema } from "../../../../packages/control-plane/plugins/git-ci/src/delivery-intent-record.js";

it("restores future backoff after the wall clock moves behind a previously due retry", () => {
  const intent = deliveryIntentSchema.parse({ schemaVersion: 1, state: "superseded",
    eventId: "1".repeat(64), eventDigest: `sha256:${"2".repeat(64)}`,
    reviewId: "3".repeat(64), envelopeId: "4".repeat(64), generationId: "5".repeat(64),
    serviceId: "ci", destinationDigest: `sha256:${"6".repeat(64)}`, ownerRequestId: "clock-regression",
    rejectionStatus: 409, rejectedAt: 1, retryAfter: 100 });
  const buckets = new Map<string, CatalogBucket>();
  addCatalogEntry(buckets, { name: "intent", intent, version: "version", bytes: 1,
    order: { createdAt: "2026-01-01T00:00:00.000Z", reviewId: intent.reviewId, jobName: "source", eventId: intent.eventId } });
  const bucket = buckets.values().next().value;
  const due = selectableIntentCursor(bucket, 200);
  if (due.kind !== "ordered") throw new Error("expected an ordered fixture cursor");
  expect(due.nextGroup()).toEqual([intent]);

  const rolledBack = selectableIntentCursor(bucket, 50);
  if (rolledBack.kind !== "ordered") throw new Error("expected an ordered fixture cursor");
  expect(rolledBack.nextGroup()).toEqual([]);
});
