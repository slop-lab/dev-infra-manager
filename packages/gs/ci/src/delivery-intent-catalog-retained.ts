import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  addCatalogEntry,
  removeCatalogEntry,
  type CatalogBucket,
  type CatalogEntry,
  type DeliveryIntentSelectionOrder
} from "./delivery-intent-catalog-index.js";
import type {
  DeliveryIntentDirectoryVersion
} from "./delivery-intent-directory-version.js";
import type {
  DeliveryIntentCatalogCapacityReservation
} from "./delivery-intent-catalog-capacity.js";
import {
  createDeliveryIntentCatalogEntry,
  deliveryIntentCatalogEntryBytes,
  deliveryIntentStoredVersion
} from "./delivery-intent-catalog-entry.js";
import {
  readStoredDeliveryIntentIfPresent,
  type DeliveryIntent,
  type StoredDeliveryIntent
} from "./delivery-intent-record.js";

export type RetainedCatalogAddition = {
  readonly name: string;
  readonly intent: DeliveryIntent;
  readonly order: DeliveryIntentSelectionOrder;
};

type RetainedAddition = RetainedCatalogAddition & {
  readonly kind: "addition";
  readonly reservation: DeliveryIntentCatalogCapacityReservation;
};

type RetainedReplacement = {
  readonly kind: "replacement";
  readonly name: string;
  readonly intent: DeliveryIntent;
  readonly order?: DeliveryIntentSelectionOrder;
  readonly previous: CatalogEntry;
  readonly reservation: DeliveryIntentCatalogCapacityReservation;
};

export type RetainedPublication = RetainedAddition | RetainedReplacement;

export type DeliveryIntentCatalogState = {
  readonly directory: string;
  readonly entries: Map<string, CatalogEntry>;
  readonly buckets: Map<string, CatalogBucket>;
  readonly retainedPublications: Map<string, RetainedPublication>;
  initialized: boolean;
  directoryVersion?: DeliveryIntentDirectoryVersion;
};

export function retainDeliveryIntentAddition(input: {
  readonly catalog: DeliveryIntentCatalogState;
  readonly reservation: DeliveryIntentCatalogCapacityReservation;
  readonly addition: RetainedCatalogAddition;
}): void {
  assertAvailable(input.catalog, input.addition.name);
  const bytes = deliveryIntentCatalogEntryBytes(
    input.addition.name, input.addition.intent, input.addition.order
  );
  input.catalog.retainedPublications.set(input.addition.name, {
    kind: "addition", ...input.addition,
    reservation: input.reservation.transferAddition(bytes)
  });
}

export function retainDeliveryIntentReplacement(input: {
  readonly catalog: DeliveryIntentCatalogState;
  readonly reservation: DeliveryIntentCatalogCapacityReservation;
  readonly name: string;
  readonly intent: DeliveryIntent;
  readonly order?: DeliveryIntentSelectionOrder;
}): void {
  assertAvailable(input.catalog, input.name);
  const previous = input.catalog.entries.get(input.name);
  if (previous === undefined) throw new DeliveryIntentCatalogRetainedError(
    "authoritative delivery intent catalog identity is unavailable"
  );
  const nextBytes = deliveryIntentCatalogEntryBytes(input.name, input.intent, input.order);
  input.catalog.retainedPublications.set(input.name, {
    kind: "replacement", name: input.name, intent: input.intent,
    previous, reservation: input.reservation.transferReplacement(previous.bytes, nextBytes),
    ...(input.order === undefined ? {} : { order: input.order })
  });
  removeCatalogEntry(input.catalog.buckets, previous);
}

export async function resolveRetainedDeliveryIntents(
  input: {
    readonly catalog: DeliveryIntentCatalogState;
    readonly admit: (entry: CatalogEntry,
      reservation: DeliveryIntentCatalogCapacityReservation) => void;
  }
): Promise<void> {
  const catalog = input.catalog;
  for (const retained of [...catalog.retainedPublications.values()]) {
    const outcome = await inspectRetained(catalog.directory, retained);
    switch (outcome.kind) {
      case "absent":
        retained.reservation.release();
        catalog.retainedPublications.delete(retained.name);
        if (retained.kind === "replacement") addCatalogEntry(catalog.buckets, retained.previous);
        break;
      case "old":
        retained.reservation.release();
        catalog.retainedPublications.delete(retained.name);
        addCatalogEntry(catalog.buckets, outcome.retained.previous);
        break;
      case "expected":
        input.admit(outcome.entry, retained.reservation);
        catalog.retainedPublications.delete(retained.name);
        break;
      case "unresolved":
        break;
      default:
        assertNever(outcome);
    }
  }
}

type RetainedOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "old"; readonly retained: RetainedReplacement }
  | { readonly kind: "expected"; readonly entry: CatalogEntry }
  | { readonly kind: "unresolved" };

async function inspectRetained(directory: string,
  retained: RetainedPublication): Promise<RetainedOutcome> {
  const stored = await readableIntent(join(directory, retained.name));
  if (stored === undefined) return { kind: "absent" };
  if (stored.kind === "unverified") return { kind: "unresolved" };
  if (retained.kind === "replacement"
    && JSON.stringify(stored.value.intent) === JSON.stringify(retained.previous.intent)
    && deliveryIntentStoredVersion(stored.value) === retained.previous.version) {
    return { kind: "old", retained };
  }
  if (JSON.stringify(stored.value.intent) !== JSON.stringify(retained.intent)) {
    return { kind: "unresolved" };
  }
  return { kind: "expected", entry: createDeliveryIntentCatalogEntry(
    retained.name, stored.value, retained.order
  ) };
}

async function readableIntent(path: string): Promise<
  | { readonly kind: "stored"; readonly value: StoredDeliveryIntent }
  | { readonly kind: "unverified" }
  | undefined
> {
  try {
    const stored = await readStoredDeliveryIntentIfPresent(path, true);
    return stored === undefined ? undefined : { kind: "stored", value: stored };
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    try { await lstat(path); return { kind: "unverified" }; }
    catch (statError) {
      return isCode(statError, "ENOENT") ? undefined : { kind: "unverified" };
    }
  }
}

function assertAvailable(catalog: DeliveryIntentCatalogState, name: string): void {
  if (catalog.retainedPublications.has(name)) {
    throw new DeliveryIntentCatalogRetainedError(
      "authoritative delivery intent publication is unresolved"
    );
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertNever(value: never): never {
  throw new DeliveryIntentCatalogRetainedError(
    `unexpected retained delivery intent outcome: ${JSON.stringify(value)}`
  );
}

export class DeliveryIntentCatalogRetainedError extends Error {
  readonly name = "DeliveryIntentCatalogRetainedError";
}
