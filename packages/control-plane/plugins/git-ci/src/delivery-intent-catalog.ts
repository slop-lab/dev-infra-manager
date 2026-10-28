import { resolve } from "node:path";
import {
  addCatalogEntry,
  removeCatalogEntry,
  selectableIntentCursor,
  type CatalogEntry,
  type DeliveryIntentCursor,
  type DeliveryIntentSelectionOrder
} from "./delivery-intent-catalog-index.js";
import {
  deliveryIntentKey,
  type DeliveryIntent,
  type StoredDeliveryIntent
} from "./delivery-intent-record.js";
import {
  inspectDeliveryIntentDirectory,
  sameDeliveryIntentDirectoryIdentity,
  sameDeliveryIntentDirectoryVersion,
  type DeliveryIntentDirectoryVersion
} from "./delivery-intent-directory-version.js";
import {
  DeliveryIntentCatalogCapacity,
  type DeliveryIntentCatalogCapacityReservation
} from "./delivery-intent-catalog-capacity.js";
import {
  assertDeliveryIntentCatalogName,
  createDeliveryIntentCatalogEntry,
  deliveryIntentCatalogEntryBytes,
  createDeliveryIntentSelectionEntry
} from "./delivery-intent-catalog-entry.js";
import { loadDeliveryIntentCatalog, reconcileDeliveryIntentCatalog } from "./delivery-intent-catalog-reconciliation.js";
import {
  assertDeliveryIntentCatalogVersion,
  recoveredDeliveryIntentCatalogEntry
} from "./delivery-intent-catalog-integrity.js";
import {
  resolveRetainedDeliveryIntents,
  retainDeliveryIntentAddition,
  retainDeliveryIntentReplacement,
  type DeliveryIntentCatalogState as DeliveryIntentCatalog,
  type RetainedCatalogAddition
} from "./delivery-intent-catalog-retained.js";

export type { DeliveryIntentCursor, DeliveryIntentSelectionOrder } from "./delivery-intent-catalog-index.js";

export type DeliveryIntentSelectionQuery = {
  readonly generationId: string;
  readonly serviceId: string;
  readonly destinationDigest: string;
  readonly now: number;
};

export type DeliveryIntentCatalogReservation = DeliveryIntentCatalogCapacityReservation;

const maximumCatalogs = 4_096;
const maximumCatalogEntries = 100_000, maximumCatalogBytes = 512 * 1024 * 1024;

const catalogs = new Map<string, DeliveryIntentCatalog>();
const catalogCapacity = new DeliveryIntentCatalogCapacity(maximumCatalogEntries, maximumCatalogBytes);

export async function initializeCatalogDeliveryIntents(directory: string): Promise<void> {
  const catalog = await catalogFor(directory);
  await refreshCatalog(catalog, false);
}

export function assertCatalogDeliveryIntentDirectoryCreation(directory: string): void {
  if (catalogs.has(resolve(directory))) {
    throw new DeliveryIntentCatalogError(
      "authoritative delivery intent directory disappeared from its catalog"
    );
  }
}

export async function readCatalogDeliveryIntents(directory: string): Promise<readonly DeliveryIntent[]> {
  const catalog = await catalogFor(directory);
  await refreshCatalog(catalog, true);
  return [...catalog.entries.values()].map(({ intent }) => intent);
}

export async function readCatalogSelectableDeliveryIntents(directory: string,
  query: DeliveryIntentSelectionQuery): Promise<DeliveryIntentCursor> {
  const catalog = await catalogFor(directory);
  await refreshCatalog(catalog, false);
  return selectableIntentCursor(catalog.buckets.get(
    `${query.generationId}\0${query.serviceId}\0${query.destinationDigest}`
  ), query.now);
}

export function reserveCatalogDeliveryIntentAdditions(
  directory: string,
  additions: readonly RetainedCatalogAddition[]
): DeliveryIntentCatalogReservation {
  const catalog = requiredCatalog(directory);
  const names = new Set<string>();
  let bytes = 0;
  for (const addition of additions) {
    if (catalog.entries.has(addition.name) || catalog.retainedPublications.has(addition.name)
      || names.has(addition.name)) {
      throw new DeliveryIntentCatalogError(
        "authoritative delivery intent name is already known to its catalog"
      );
    }
    names.add(addition.name);
    bytes += deliveryIntentCatalogEntryBytes(addition.name, addition.intent, addition.order);
  }
  return catalogCapacity.reserve(additions.length, bytes);
}

export function reserveCatalogDeliveryIntentReplacement(directory: string,
  name: string, intent: DeliveryIntent,
  order?: DeliveryIntentSelectionOrder): DeliveryIntentCatalogReservation {
  const catalog = requiredCatalog(directory);
  if (catalog.retainedPublications.has(name)) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent publication is unresolved");
  }
  const previous = catalog.entries.get(name);
  if (previous === undefined) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent catalog identity is unavailable");
  }
  const nextBytes = deliveryIntentCatalogEntryBytes(name, intent, order);
  return catalogCapacity.reserve(0, Math.max(0, nextBytes - previous.bytes));
}

export function publishCatalogDeliveryIntent(directory: string, publication: {
  readonly name: string;
  readonly stored: StoredDeliveryIntent;
  readonly order?: DeliveryIntentSelectionOrder;
}, reservation: DeliveryIntentCatalogReservation): void {
  const catalog = requiredCatalog(directory);
  assertDeliveryIntentCatalogName(publication.name, publication.stored.intent);
  setCatalogEntry(catalog, createDeliveryIntentCatalogEntry(
    publication.name, publication.stored, publication.order
  ), reservation);
}

export function recoverCatalogDeliveryIntentLink(directory: string,
  name: string, stored: StoredDeliveryIntent): void {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) return;
  const current = catalog.entries.get(name);
  if (current === undefined) return;
  const next = recoveredDeliveryIntentCatalogEntry(current, name, stored);
  const reservation = catalogCapacity.reserve(0, Math.max(0, next.bytes - current.bytes));
  try { setCatalogEntry(catalog, next, reservation); }
  finally { reservation.release(); }
}

export function retainCatalogDeliveryIntentAddition(directory: string,
  reservation: DeliveryIntentCatalogReservation, addition: RetainedCatalogAddition): void {
  retainDeliveryIntentAddition({ catalog: requiredCatalog(directory), reservation, addition });
}

export function retainCatalogDeliveryIntentReplacement(directory: string,
  reservation: DeliveryIntentCatalogReservation, name: string,
  intent: DeliveryIntent, order?: DeliveryIntentSelectionOrder): void {
  retainDeliveryIntentReplacement({ catalog: requiredCatalog(directory), reservation,
    name, intent, ...(order === undefined ? {} : { order }) });
}

export async function resolveCatalogDeliveryIntentRetained(directory: string): Promise<void> {
  const catalog = requiredCatalog(directory);
  await resolveRetainedDeliveryIntents({ catalog, admit: (entry, reservation) =>
    setCatalogEntry(catalog, entry, reservation) });
}

export function assertCatalogDeliveryIntentVersion(directory: string,
  expected: DeliveryIntent, stored: StoredDeliveryIntent): void {
  const current = requiredCatalog(directory).entries.get(`${deliveryIntentKey(expected)}.json`);
  assertDeliveryIntentCatalogVersion(current, expected, stored);
}

export function rememberDeliveryIntentSelectionOrder(directory: string,
  intent: DeliveryIntent, order: DeliveryIntentSelectionOrder): void {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) return;
  const { current, next } = createDeliveryIntentSelectionEntry(catalog.entries, intent, order);
  const reservation = catalogCapacity.reserve(0, Math.max(0, next.bytes - current.bytes));
  try { setCatalogEntry(catalog, next, reservation); }
  finally { reservation.release(); }
}

export function rememberDeliveryIntentSelectionOrders(directory: string,
  selections: readonly { readonly intent: DeliveryIntent;
    readonly order: DeliveryIntentSelectionOrder }[]): void {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) return;
  const replacements = selections.map(({ intent, order }) =>
    createDeliveryIntentSelectionEntry(catalog.entries, intent, order));
  const reservation = catalogCapacity.reserve(0, replacements.reduce((bytes, { current, next }) =>
    bytes + Math.max(0, next.bytes - current.bytes), 0));
  try {
    for (const { next } of replacements) setCatalogEntry(catalog, next, reservation);
  } finally {
    reservation.release();
  }
  catalog.buckets.clear();
  for (const entry of catalog.entries.values()) addCatalogEntry(catalog.buckets, entry, true);
}

export function deliveryIntentSelectionOrder(directory: string,
  intent: DeliveryIntent): DeliveryIntentSelectionOrder | undefined {
  return requiredCatalog(directory).entries.get(`${deliveryIntentKey(intent)}.json`)?.order;
}

async function catalogFor(directory: string): Promise<DeliveryIntentCatalog> {
  return loadDeliveryIntentCatalog({ directory, catalogs, maximumCatalogs,
    reconcile: (catalog, before) => reconcileCatalog(catalog, before, false) });
}

async function refreshCatalog(catalog: DeliveryIntentCatalog, auditEveryRecord: boolean): Promise<void> {
  const before = await inspectDeliveryIntentDirectory(catalog.directory);
  if (catalog.directoryVersion === undefined) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent catalog identity is unavailable");
  }
  if (!sameDeliveryIntentDirectoryIdentity(catalog.directoryVersion, before)) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent directory was replaced");
  }
  await resolveCatalogDeliveryIntentRetained(catalog.directory);
  if (auditEveryRecord && catalog.retainedPublications.size > 0) {
    throw new DeliveryIntentCatalogError(
      "authoritative delivery intent publication remains unresolved"
    );
  }
  if (!auditEveryRecord && sameDeliveryIntentDirectoryVersion(catalog.directoryVersion, before)) return;
  await reconcileCatalog(catalog, before, auditEveryRecord);
}

async function reconcileCatalog(catalog: DeliveryIntentCatalog,
  before: DeliveryIntentDirectoryVersion, auditEveryRecord: boolean): Promise<void> {
  const reconciliation = await reconcileDeliveryIntentCatalog({ directory: catalog.directory,
    entries: catalog.entries, retainedNames: new Set(catalog.retainedPublications.keys()),
    before, auditEveryRecord });
  const reservation = catalogCapacity.reserve(reconciliation.additions.length,
    reconciliation.additions.reduce((bytes, entry) => bytes + entry.bytes, 0));
  try {
    for (const entry of reconciliation.additions) setCatalogEntry(catalog, entry, reservation);
  } finally {
    reservation.release();
  }
  catalog.initialized = true;
  catalog.directoryVersion = reconciliation.directoryVersion;
}

function setCatalogEntry(catalog: DeliveryIntentCatalog, entry: CatalogEntry,
  reservation: DeliveryIntentCatalogReservation): void {
  const previous = catalog.entries.get(entry.name);
  if (previous === undefined) reservation.consumeAddition(entry.bytes);
  else reservation.consumeReplacement(previous.bytes, entry.bytes);
  if (previous !== undefined) removeCatalogEntry(catalog.buckets, previous);
  catalog.entries.set(entry.name, entry);
  addCatalogEntry(catalog.buckets, entry, !catalog.initialized);
}

function requiredCatalog(directory: string): DeliveryIntentCatalog {
  const catalog = catalogs.get(resolve(directory));
  if (catalog === undefined) {
    throw new DeliveryIntentCatalogError("authoritative delivery intent catalog is not initialized");
  }
  return catalog;
}

export class DeliveryIntentCatalogError extends Error {
  readonly name = "DeliveryIntentCatalogError";
}
