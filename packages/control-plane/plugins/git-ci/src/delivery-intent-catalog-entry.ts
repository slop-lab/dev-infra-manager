import {
  compareSelectionOrder,
  type CatalogEntry,
  type DeliveryIntentSelectionOrder
} from "./delivery-intent-catalog-index.js";
import {
  deliveryIntentKey,
  deliveryIntentRecordVersion,
  deliveryIntentRecordVersionKey,
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

export function createDeliveryIntentSelectionEntry(entries: ReadonlyMap<string, CatalogEntry>,
  intent: DeliveryIntent, order: DeliveryIntentSelectionOrder): {
    readonly current: CatalogEntry;
    readonly next: CatalogEntry;
  } {
  const name = `${deliveryIntentKey(intent)}.json`;
  const current = entries.get(name);
  if (current === undefined || JSON.stringify(current.intent) !== JSON.stringify(intent)) {
    throw new DeliveryIntentCatalogEntryError(
      "authoritative delivery intent catalog identity is unavailable"
    );
  }
  const selectedOrder = current.order === undefined || compareSelectionOrder(order, current.order) < 0
    ? order
    : current.order;
  return { current, next: { ...current, order: selectedOrder,
    bytes: deliveryIntentCatalogEntryBytes(name, current.intent, selectedOrder) } };
}

export function deliveryIntentStoredVersion(
  stored: StoredDeliveryIntent
): string {
  return deliveryIntentRecordVersionKey(deliveryIntentRecordVersion(stored.stat));
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
