import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  addCatalogEntry,
  compareSelectionOrder,
  removeCatalogEntry,
  selectableIntentCursor,
  type CatalogBucket,
  type CatalogEntry,
  type DeliveryIntentCursor,
  type DeliveryIntentSelectionOrder
} from "./delivery-intent-catalog-index.js";
import {
  deliveryIntentKey,
  readStoredDeliveryIntent,
  type DeliveryIntent,
  type StoredDeliveryIntent
} from "./delivery-intent-record.js";
import {
  inspectDeliveryIntentDirectory,
  sameDeliveryIntentDirectoryIdentity,
  sameDeliveryIntentDirectoryVersion,
  type DeliveryIntentDirectoryVersion
} from "./delivery-intent-directory-version.js";
import { DeliveryIntentCatalogCapacity } from "./delivery-intent-catalog-capacity.js";
import {
  assertDeliveryIntentCatalogName,
  createDeliveryIntentCatalogEntry,
  deliveryIntentCatalogEntryBytes,
  deliveryIntentStoredVersion
} from "./delivery-intent-catalog-entry.js";

export type { DeliveryIntentCursor, DeliveryIntentSelectionOrder } from "./delivery-intent-catalog-index.js";

export type DeliveryIntentSelectionQuery = {
  readonly generationId: string;
  readonly serviceId: string;
  readonly destinationDigest: string;
  readonly now: number;
};

const maximumEvents = 100_000;
const maximumCatalogs = 4_096;
const maximumCatalogEntries = 100_000;
const maximumCatalogBytes = 512 * 1024 * 1024;
const recordPattern = /^[0-9a-f]{64}\.json$/;

type DeliveryIntentCatalog = {
  readonly directory: string;
  readonly entries: Map<string, CatalogEntry>;
  readonly buckets: Map<string, CatalogBucket>;
  readonly dirtyNames: Set<string>;
  initialized: boolean;
  enumerateDirectory: boolean;
  verifyEveryRecord: boolean;
  directoryVersion?: DeliveryIntentDirectoryVersion;
  watcher?: FSWatcher;
};

const catalogs = new Map<string, DeliveryIntentCatalog>();
const catalogCapacity = new DeliveryIntentCatalogCapacity(maximumCatalogEntries, maximumCatalogBytes);

export async function readCatalogDeliveryIntents(directory: string): Promise<readonly DeliveryIntent[]> {
  const catalog = catalogFor(directory);
  await refreshCatalog(catalog, true);
  return [...catalog.entries.values()].map(({ intent }) => intent);
}

export async function readCatalogSelectableDeliveryIntents(directory: string,
  query: DeliveryIntentSelectionQuery): Promise<DeliveryIntentCursor> {
  const catalog = catalogFor(directory);
  await refreshCatalog(catalog, false);
  return selectableIntentCursor(catalog.buckets.get(
    `${query.generationId}\0${query.serviceId}\0${query.destinationDigest}`
  ), query.now);
}

export function publishCatalogDeliveryIntent(directory: string, publication: {
  readonly name: string;
  readonly stored: StoredDeliveryIntent;
  readonly order?: DeliveryIntentSelectionOrder;
}): void {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) return;
  assertDeliveryIntentCatalogName(publication.name, publication.stored.intent);
  setCatalogEntry(catalog, createDeliveryIntentCatalogEntry(
    publication.name, publication.stored, publication.order
  ));
  catalog.dirtyNames.delete(publication.name);
}

export function assertCatalogDeliveryIntentAdditions(directory: string,
  additions: readonly { readonly name: string; readonly intent: DeliveryIntent;
    readonly order: DeliveryIntentSelectionOrder }[]): void {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) return;
  const novel = additions.filter(({ name }) => !catalog.entries.has(name));
  catalogCapacity.assertAdditional(novel.length,
    novel.reduce((bytes, addition) => bytes
      + deliveryIntentCatalogEntryBytes(addition.name, addition.intent, addition.order), 0));
}

export function rememberDeliveryIntentSelectionOrder(directory: string,
  intent: DeliveryIntent, order: DeliveryIntentSelectionOrder): void {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) return;
  const name = `${deliveryIntentKey(intent)}.json`;
  const current = catalog.entries.get(name);
  if (current === undefined || JSON.stringify(current.intent) !== JSON.stringify(intent)) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent catalog identity is unavailable");
  }
  const selectedOrder = current.order === undefined || compareSelectionOrder(order, current.order) < 0
    ? order
    : current.order;
  setCatalogEntry(catalog, {
    ...current,
    order: selectedOrder,
    bytes: deliveryIntentCatalogEntryBytes(name, current.intent, selectedOrder)
  });
}

export function rememberDeliveryIntentSelectionOrders(directory: string,
  selections: readonly { readonly intent: DeliveryIntent;
    readonly order: DeliveryIntentSelectionOrder }[]): void {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) return;
  for (const { intent, order } of selections) {
    const name = `${deliveryIntentKey(intent)}.json`;
    const current = catalog.entries.get(name);
    if (current === undefined || JSON.stringify(current.intent) !== JSON.stringify(intent)) {
      throw new DeliveryIntentCatalogError("authoritative delivery intent catalog identity is unavailable");
    }
    const selectedOrder = current.order === undefined || compareSelectionOrder(order, current.order) < 0
      ? order
      : current.order;
    const next = { ...current, order: selectedOrder,
      bytes: deliveryIntentCatalogEntryBytes(name, current.intent, selectedOrder) };
    catalogCapacity.replace(current.bytes, next.bytes);
    catalog.entries.set(name, next);
  }
  catalog.buckets.clear();
  for (const entry of catalog.entries.values()) addCatalogEntry(catalog.buckets, entry, true);
}

export function deliveryIntentSelectionOrder(directory: string,
  intent: DeliveryIntent): DeliveryIntentSelectionOrder | undefined {
  return catalogs.get(resolve(directory))?.entries.get(`${deliveryIntentKey(intent)}.json`)?.order;
}

function catalogFor(directory: string): DeliveryIntentCatalog {
  const key = resolve(directory);
  const existing = catalogs.get(key);
  if (existing !== undefined) return existing;
  if (catalogs.size >= maximumCatalogs) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent catalog capacity is exceeded");
  }
  const catalog: DeliveryIntentCatalog = { directory: key, entries: new Map(), buckets: new Map(),
    dirtyNames: new Set(), initialized: false, enumerateDirectory: false, verifyEveryRecord: false };
  catalog.watcher = watch(key, { persistent: false }, (_event, name) => {
    if (name === null) catalog.enumerateDirectory = true;
    else catalog.dirtyNames.add(name);
  });
  catalog.watcher.on("error", () => {
    catalog.enumerateDirectory = true;
    catalog.verifyEveryRecord = true;
  });
  catalogs.set(key, catalog);
  return catalog;
}

async function refreshCatalog(catalog: DeliveryIntentCatalog, revalidateAll: boolean): Promise<void> {
  await new Promise<void>((complete) => setImmediate(complete));
  const before = await inspectDeliveryIntentDirectory(catalog.directory);
  if (catalog.directoryVersion !== undefined) {
    if (!sameDeliveryIntentDirectoryIdentity(catalog.directoryVersion, before)) {
      throw new DeliveryIntentCatalogError("authoritative delivery intent directory was replaced");
    }
    if (!sameDeliveryIntentDirectoryVersion(catalog.directoryVersion, before)) catalog.enumerateDirectory = true;
  }
  for (const name of catalog.dirtyNames) {
    if (recordPattern.test(name)) continue;
    catalog.dirtyNames.delete(name);
    catalog.enumerateDirectory = true;
  }
  if (!catalog.initialized || catalog.enumerateDirectory || catalog.verifyEveryRecord || revalidateAll) {
    await enumerateCatalog(catalog, revalidateAll || catalog.verifyEveryRecord);
  }
  if (revalidateAll || catalog.verifyEveryRecord) {
    catalog.buckets.clear();
    catalog.initialized = false;
  }
  await refreshDirtyEntries(catalog);
  const after = await inspectDeliveryIntentDirectory(catalog.directory);
  if (!sameDeliveryIntentDirectoryVersion(before, after)) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent directory changed during inspection");
  }
  catalog.initialized = true;
  catalog.verifyEveryRecord = false;
  catalog.directoryVersion = after;
}

async function enumerateCatalog(catalog: DeliveryIntentCatalog, revalidateAll: boolean): Promise<void> {
  const directoryEntries = (await readdir(catalog.directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (directoryEntries.length > maximumEvents) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent capacity is exceeded");
  }
  const names = new Set<string>();
  for (const entry of directoryEntries) {
    if (!entry.isFile() || !recordPattern.test(entry.name)) {
      throw new DeliveryIntentCatalogError("authoritative delivery intent name is invalid");
    }
    names.add(entry.name);
  }
  for (const name of catalog.entries.keys()) {
    if (!names.has(name)) {
      throw new DeliveryIntentCatalogError("authoritative delivery intent disappeared from its catalog");
    }
  }
  for (const name of names) {
    if (revalidateAll || !catalog.entries.has(name)) catalog.dirtyNames.add(name);
  }
  catalog.enumerateDirectory = false;
}

async function refreshDirtyEntries(catalog: DeliveryIntentCatalog): Promise<void> {
  for (const name of [...catalog.dirtyNames].sort()) {
    const previous = catalog.entries.get(name);
    catalog.dirtyNames.delete(name);
    let stored: StoredDeliveryIntent;
    try {
      stored = await readStoredDeliveryIntent(join(catalog.directory, name), true);
    } catch (error) {
      if (isCode(error, "ENOENT") && previous !== undefined) {
        throw new DeliveryIntentCatalogError("authoritative delivery intent disappeared from its catalog");
      }
      throw error;
    }
    assertDeliveryIntentCatalogName(name, stored.intent);
    if (previous !== undefined && (previous.version !== deliveryIntentStoredVersion(stored)
      || JSON.stringify(previous.intent) !== JSON.stringify(stored.intent))) {
      throw new DeliveryIntentCatalogError("authoritative delivery intent changed after catalog verification");
    }
    setCatalogEntry(catalog, createDeliveryIntentCatalogEntry(name, stored, previous?.order));
  }
}

function setCatalogEntry(catalog: DeliveryIntentCatalog, entry: CatalogEntry): void {
  const previous = catalog.entries.get(entry.name);
  catalogCapacity.replace(previous?.bytes, entry.bytes);
  if (previous !== undefined) removeCatalogEntry(catalog.buckets, previous);
  catalog.entries.set(entry.name, entry);
  addCatalogEntry(catalog.buckets, entry, !catalog.initialized);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class DeliveryIntentCatalogError extends Error {
  readonly name = "DeliveryIntentCatalogError";
}
