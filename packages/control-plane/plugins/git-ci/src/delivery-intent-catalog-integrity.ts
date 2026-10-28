import type { CatalogEntry } from "./delivery-intent-catalog-index.js";
import {
  assertDeliveryIntentCatalogName,
  createDeliveryIntentCatalogEntry,
  deliveryIntentStoredVersion
} from "./delivery-intent-catalog-entry.js";
import {
  deliveryIntentRecordVersion,
  sameDeliveryIntentRecordIdentityKey,
  type DeliveryIntent,
  type StoredDeliveryIntent
} from "./delivery-intent-record.js";

export function assertDeliveryIntentCatalogVersion(
  current: CatalogEntry | undefined,
  expected: DeliveryIntent,
  stored: StoredDeliveryIntent
): void {
  if (current === undefined
    || JSON.stringify(current.intent) !== JSON.stringify(expected)
    || JSON.stringify(stored.intent) !== JSON.stringify(expected)
    || current.version !== deliveryIntentStoredVersion(stored)) {
    throw new DeliveryIntentCatalogIntegrityError(
      "authoritative delivery intent changed before publication"
    );
  }
}

export function recoveredDeliveryIntentCatalogEntry(
  current: CatalogEntry | undefined,
  name: string,
  stored: StoredDeliveryIntent
): CatalogEntry {
  assertDeliveryIntentCatalogName(name, stored.intent);
  if (current === undefined || JSON.stringify(current.intent) !== JSON.stringify(stored.intent)
    || !sameDeliveryIntentRecordIdentityKey(
      current.version, deliveryIntentRecordVersion(stored.stat)
    )) {
    throw new DeliveryIntentCatalogIntegrityError(
      "authoritative delivery intent recovery conflicts with its catalog"
    );
  }
  return createDeliveryIntentCatalogEntry(name, stored, current.order);
}

export class DeliveryIntentCatalogIntegrityError extends Error {
  readonly name = "DeliveryIntentCatalogIntegrityError";
}
