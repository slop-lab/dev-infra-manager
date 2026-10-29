import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CatalogEntry } from "./delivery-intent-catalog-index.js";
import type { DeliveryIntentCatalogState } from "./delivery-intent-catalog-retained.js";
import {
  assertDeliveryIntentCatalogName,
  createDeliveryIntentCatalogEntry,
  deliveryIntentStoredVersion
} from "./delivery-intent-catalog-entry.js";
import {
  inspectDeliveryIntentDirectory,
  sameDeliveryIntentDirectoryVersion,
  type DeliveryIntentDirectoryVersion
} from "./delivery-intent-directory-version.js";
import {
  inspectDeliveryIntentRecordVersion,
  deliveryIntentRecordVersionKey,
  readStoredDeliveryIntent,
} from "./delivery-intent-record.js";

const maximumEvents = 100_000;
const recordPattern = /^[0-9a-f]{64}\.json$/;

export async function loadDeliveryIntentCatalog(input: {
  readonly directory: string;
  readonly catalogs: Map<string, DeliveryIntentCatalogState>;
  readonly maximumCatalogs: number;
  readonly reconcile: (catalog: DeliveryIntentCatalogState, before: DeliveryIntentDirectoryVersion) => Promise<void>;
}): Promise<DeliveryIntentCatalogState> {
  const key = resolve(input.directory);
  const existing = input.catalogs.get(key);
  if (existing !== undefined) return existing;
  if (input.catalogs.size >= input.maximumCatalogs) {
    throw new DeliveryIntentCatalogReconciliationError("authoritative delivery intent catalog capacity is exceeded");
  }
  const catalog: DeliveryIntentCatalogState = { directory: key, entries: new Map(),
    buckets: new Map(), retainedPublications: new Map(), initialized: false };
  input.catalogs.set(key, catalog);
  try {
    const before = await inspectDeliveryIntentDirectory(key);
    await input.reconcile(catalog, before);
    return catalog;
  } catch (error) {
    input.catalogs.delete(key);
    throw error;
  }
}

export type DeliveryIntentCatalogReconciliation = {
  readonly additions: readonly CatalogEntry[];
  readonly directoryVersion: DeliveryIntentDirectoryVersion;
};

export async function reconcileDeliveryIntentCatalog(input: {
  readonly directory: string;
  readonly entries: ReadonlyMap<string, CatalogEntry>;
  readonly retainedNames: ReadonlySet<string>;
  readonly before: DeliveryIntentDirectoryVersion;
  readonly auditEveryRecord: boolean;
}): Promise<DeliveryIntentCatalogReconciliation> {
  const directoryEntries = (await readdir(input.directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (directoryEntries.length > maximumEvents) {
    throw new DeliveryIntentCatalogReconciliationError(
      "authoritative delivery intent capacity is exceeded"
    );
  }
  const names = new Set<string>();
  for (const entry of directoryEntries) {
    if (!entry.isFile() || !recordPattern.test(entry.name)) {
      throw new DeliveryIntentCatalogReconciliationError(
        "authoritative delivery intent name is invalid"
      );
    }
    names.add(entry.name);
  }
  for (const name of input.entries.keys()) {
    if (!names.has(name)) {
      throw new DeliveryIntentCatalogReconciliationError(
        "authoritative delivery intent disappeared from its catalog"
      );
    }
  }
  const additions: CatalogEntry[] = [];
  for (const name of names) {
    if (input.retainedNames.has(name)) continue;
    const previous = input.entries.get(name);
    if (previous === undefined) {
      const stored = await readStoredDeliveryIntent(join(input.directory, name), true);
      assertDeliveryIntentCatalogName(name, stored.intent);
      additions.push(createDeliveryIntentCatalogEntry(name, stored));
      continue;
    }
    if (input.auditEveryRecord) {
      const stored = await readStoredDeliveryIntent(join(input.directory, name), true);
      assertDeliveryIntentCatalogName(name, stored.intent);
      if (previous.version !== deliveryIntentStoredVersion(stored)
        || JSON.stringify(previous.intent) !== JSON.stringify(stored.intent)) {
        changed();
      }
      continue;
    }
    const version = await inspectDeliveryIntentRecordVersion(join(input.directory, name), true);
    if (previous.version !== deliveryIntentRecordVersionKey(version)) changed();
  }
  const after = await inspectDeliveryIntentDirectory(input.directory);
  if (!sameDeliveryIntentDirectoryVersion(input.before, after)) {
    throw new DeliveryIntentCatalogReconciliationError(
      "authoritative delivery intent directory changed during inspection"
    );
  }
  return { additions, directoryVersion: after };
}

function changed(): never {
  throw new DeliveryIntentCatalogReconciliationError(
    "authoritative delivery intent changed after catalog verification"
  );
}

export class DeliveryIntentCatalogReconciliationError extends Error {
  readonly name = "DeliveryIntentCatalogReconciliationError";
}
