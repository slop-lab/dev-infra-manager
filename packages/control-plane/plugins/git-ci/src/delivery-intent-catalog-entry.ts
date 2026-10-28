import type { CatalogEntry, DeliveryIntentSelectionOrder } from "./delivery-intent-catalog-index.js";
import {
  deliveryIntentKey,
  type DeliveryIntent,
  type StoredDeliveryIntent
} from "./delivery-intent-record.js";

export function createDeliveryIntentCatalogEntry(name: string, stored: StoredDeliveryIntent,
  order?: DeliveryIntentSelectionOrder): CatalogEntry {
  return { name, intent: stored.intent, version: deliveryIntentStoredVersion(stored),
    bytes: deliveryIntentCatalogEntryBytes(name, stored.intent, order),
    ...(order === undefined ? {} : { order }) };
}

export function deliveryIntentCatalogEntryBytes(name: string, intent: DeliveryIntent,
  order?: DeliveryIntentSelectionOrder): number {
  return Buffer.byteLength(name) + Buffer.byteLength(JSON.stringify(intent))
    + (order === undefined ? 0 : Buffer.byteLength(JSON.stringify(order))) + 128;
}

export function deliveryIntentStoredVersion(stored: StoredDeliveryIntent): string {
  const stat = stored.stat;
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs,
    stat.uid, stat.mode, stat.nlink]);
}

export function assertDeliveryIntentCatalogName(name: string, intent: DeliveryIntent): void {
  if (name !== `${deliveryIntentKey(intent)}.json`) {
    throw new DeliveryIntentCatalogEntryError(
      "authoritative delivery intent path conflicts with its identity"
    );
  }
}

export class DeliveryIntentCatalogEntryError extends Error {
  readonly name = "DeliveryIntentCatalogEntryError";
}
