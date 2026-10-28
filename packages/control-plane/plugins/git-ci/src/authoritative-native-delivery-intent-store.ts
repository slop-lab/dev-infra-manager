import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ownedReviewDirectory, publishReviewRecord, readReviewJson, replaceReviewRecord } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import type { AuthoritativeNativeReviewEnvelope } from "./plan-schema.js";
import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import {
  deliveryIntentIdentity,
  deliveryIntentKey,
  deliveryIntentSchema,
  maximumDeliveryIntentBytes,
  readStoredDeliveryIntent,
  readStoredDeliveryIntentIfPresent,
  sameDeliveryIntentIdentity,
  type DeliveryIntent
} from "./delivery-intent-record.js";
import {
  assertCatalogDeliveryIntentAdditions,
  deliveryIntentSelectionOrder,
  publishCatalogDeliveryIntent,
  readCatalogDeliveryIntents,
  readCatalogSelectableDeliveryIntents,
  rememberDeliveryIntentSelectionOrder,
  rememberDeliveryIntentSelectionOrders,
  type DeliveryIntentCursor,
  type DeliveryIntentSelectionOrder
} from "./delivery-intent-catalog.js";

export type { DeliveryIntent } from "./delivery-intent-record.js";

const maximumEvents = 100_000;
type IntentPaths = { readonly intents: string; readonly staging: string };
const operations = new Map<string, Promise<void>>();
const recordPattern = /^[0-9a-f]{64}\.json$/;
const stagingPattern = /^([0-9a-f]{64}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export async function recordExplicitAuthoritativeNativeDeliveryIntent(repository: string,
  envelope: AuthoritativeNativeReviewEnvelope, generationId: string, binding: AuthoritativeNativeDeliveryBinding,
  ownerRequestId: string): Promise<void> {
  await withIntentOperation(repository, () => recordExplicitUnlocked(repository, envelope, generationId, binding, ownerRequestId));
}

async function recordExplicitUnlocked(repository: string, envelope: AuthoritativeNativeReviewEnvelope,
  generationId: string, binding: AuthoritativeNativeDeliveryBinding, ownerRequestId: string): Promise<void> {
  const paths = await initializeUnlocked(repository);
  const entries = await readdir(paths.intents, { withFileTypes: true });
  const existingNames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !recordPattern.test(entry.name)) {
      throw new DeliveryIntentStoreError("authoritative delivery intent name is invalid");
    }
    existingNames.add(entry.name);
  }
  const candidates = envelope.events.map((event) => {
    const eventDigest = `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
    const intent = deliveryIntentSchema.parse({ schemaVersion: 1, state: "pending", eventId: event.eventId, eventDigest,
      reviewId: envelope.review.reviewId, envelopeId: envelope.envelopeId, generationId, serviceId: binding.serviceId,
      destinationDigest: binding.destinationDigest, ownerRequestId });
    const order = { createdAt: envelope.review.createdAt, reviewId: event.reviewId,
      jobName: event.jobName, eventId: event.eventId } satisfies DeliveryIntentSelectionOrder;
    return { intent, name: `${deliveryIntentKey(intent)}.json`, order };
  });
  for (const candidate of candidates) {
    if (!existingNames.has(candidate.name)) continue;
    const existing = deliveryIntentSchema.parse(await readReviewJson(join(paths.intents, candidate.name), maximumDeliveryIntentBytes, true));
    if (!sameDeliveryIntentIdentity(existing, candidate.intent)) throw new DeliveryIntentStoreError("authoritative delivery intent conflicts");
    rememberDeliveryIntentSelectionOrder(paths.intents, existing, candidate.order);
  }
  const novel = candidates.filter(({ name }) => !existingNames.has(name));
  assertCatalogDeliveryIntentAdditions(paths.intents, novel);
  if (entries.length + novel.length > maximumEvents) {
    throw new DeliveryIntentStoreError("authoritative delivery intent capacity is exceeded");
  }
  for (const candidate of novel) {
    const path = join(paths.intents, candidate.name);
    try { await publishReviewRecord({ path, serialized: `${JSON.stringify(candidate.intent)}\n`, stagingRoot: paths.staging, faults: {} }); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const existing = deliveryIntentSchema.parse(await readReviewJson(path, maximumDeliveryIntentBytes, true));
      if (!sameDeliveryIntentIdentity(existing, candidate.intent)) throw new DeliveryIntentStoreError("authoritative delivery intent conflicts");
    }
    publishCatalogDeliveryIntent(paths.intents, { name: candidate.name,
      stored: await readStoredDeliveryIntent(path, true), order: candidate.order });
  }
}

export async function readSelectableDeliveryIntents(directory: string,
  binding: AuthoritativeNativeDeliveryBinding, generationId: string,
  now: number): Promise<readonly DeliveryIntent[]> {
  const cursor = await readSelectableDeliveryIntentCursor(directory, binding, generationId, now);
  if (cursor.kind === "unprimed") return cursor.intents;
  const intents: DeliveryIntent[] = [];
  while (true) {
    const group = cursor.nextGroup();
    if (group.length === 0) return intents;
    intents.push(...group);
  }
}

export async function readSelectableDeliveryIntentCursor(directory: string,
  binding: AuthoritativeNativeDeliveryBinding, generationId: string,
  now: number): Promise<DeliveryIntentCursor> {
  return withIntentOperation(repositoryFromIntentDirectory(directory),
    () => readCatalogSelectableDeliveryIntents(directory, { generationId,
      serviceId: binding.serviceId, destinationDigest: binding.destinationDigest, now }));
}

export async function readVerifiedDeliveryIntents(directory: string): Promise<readonly DeliveryIntent[]> {
  return withIntentOperation(repositoryFromIntentDirectory(directory),
    () => readCatalogDeliveryIntents(directory));
}

export async function withCurrentDeliveryIntent<Result>(paths: IntentPaths,
  expected: DeliveryIntent, operation: (current: DeliveryIntent) => Promise<Result>): Promise<Result> {
  return withIntentOperation(repositoryFromIntentDirectory(paths.intents), async () => {
    const path = join(paths.intents, `${deliveryIntentKey(expected)}.json`);
    const stored = await readStoredDeliveryIntent(path, true);
    if (JSON.stringify(stored.intent) !== JSON.stringify(expected)) {
      throw new DeliveryIntentStoreError("authoritative delivery intent changed before publication");
    }
    return operation(stored.intent);
  });
}

export async function completeCurrentDeliveryIntent(paths: IntentPaths,
  previous: DeliveryIntent, executionId: string): Promise<void> {
  await replaceIntentUnlocked(paths, previous,
    deliveryIntentSchema.parse({ ...deliveryIntentIdentity(previous), state: "completed", executionId }));
}

export async function supersedeCurrentDeliveryIntent(paths: IntentPaths,
  previous: DeliveryIntent, rejectionStatus: 404 | 409,
  rejectedAt: number, retryAfter: number): Promise<void> {
  await replaceIntentUnlocked(paths, previous, deliveryIntentSchema.parse({
    ...deliveryIntentIdentity(previous), state: "superseded", rejectionStatus, rejectedAt, retryAfter
  }));
}

export async function initializeDeliveryIntentStore(repository: string): Promise<IntentPaths> {
  return withIntentOperation(repository, () => initializeUnlocked(repository));
}

async function initializeUnlocked(repository: string): Promise<IntentPaths> {
  const root = join(repository, "dim-git-ci-deliveries"), paths = { intents: join(root, "intents"), staging: join(root, "intent-staging") };
  await ownedReviewDirectory(root);
  await syncDirectory(repository);
  await ownedReviewDirectory(paths.intents); await ownedReviewDirectory(paths.staging);
  await syncDirectory(root);
  await recoverIntentStaging(paths);
  return paths;
}

async function replaceIntentUnlocked(paths: IntentPaths, previous: DeliveryIntent, next: DeliveryIntent): Promise<void> {
  if (!sameDeliveryIntentIdentity(previous, next)) throw new DeliveryIntentStoreError("authoritative delivery intent identity changed");
  await replaceReviewRecord({ path: join(paths.intents, `${deliveryIntentKey(previous)}.json`), serialized: `${JSON.stringify(next)}\n`, stagingRoot: paths.staging, faults: {} });
  const name = `${deliveryIntentKey(previous)}.json`;
  const order = deliveryIntentSelectionOrder(paths.intents, previous);
  publishCatalogDeliveryIntent(paths.intents, { name,
    stored: await readStoredDeliveryIntent(join(paths.intents, name), true),
    ...(order === undefined ? {} : { order }) });
}

export function rememberDeliveryIntentOrder(directory: string, intent: DeliveryIntent,
  order: DeliveryIntentSelectionOrder): void {
  rememberDeliveryIntentSelectionOrder(directory, intent, order);
}

export function rememberDeliveryIntentOrders(directory: string,
  selections: readonly { readonly intent: DeliveryIntent;
    readonly order: DeliveryIntentSelectionOrder }[]): void {
  rememberDeliveryIntentSelectionOrders(directory, selections);
}

export function readDeliveryIntentOrder(directory: string,
  intent: DeliveryIntent): DeliveryIntentSelectionOrder | undefined {
  return deliveryIntentSelectionOrder(directory, intent);
}

async function recoverIntentStaging(paths: IntentPaths): Promise<void> {
  for (const entry of (await readdir(paths.staging, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const match = stagingPattern.exec(entry.name);
    if (!entry.isFile() || match === null || match[1] === undefined) {
      throw new DeliveryIntentStoreError("authoritative delivery intent staging entry is invalid");
    }
    const finalName = match[1];
    const stagedPath = join(paths.staging, entry.name);
    const finalPath = join(paths.intents, finalName);
    const staged = await readStoredDeliveryIntent(stagedPath);
    assertIntentName(finalName, staged.intent);
    if (staged.stat.nlink === 2) {
      const final = await readStoredDeliveryIntent(finalPath);
      assertIntentName(finalName, final.intent);
      if (!sameDeliveryIntentIdentity(staged.intent, final.intent) || final.stat.nlink !== 2
        || staged.stat.dev !== final.stat.dev || staged.stat.ino !== final.stat.ino) {
        throw new DeliveryIntentStoreError("published delivery intent staging identity is invalid");
      }
    } else if (staged.stat.nlink === 1) {
      const final = await readStoredDeliveryIntentIfPresent(finalPath);
      if (final !== undefined) {
        assertIntentName(finalName, final.intent);
        if (!sameDeliveryIntentIdentity(staged.intent, final.intent) || final.stat.nlink !== 1
          || staged.stat.dev === final.stat.dev && staged.stat.ino === final.stat.ino) {
          throw new DeliveryIntentStoreError("replacement delivery intent staging identity is invalid");
        }
      }
    } else {
      throw new DeliveryIntentStoreError("authoritative delivery intent staging link count is invalid");
    }
    await unlink(stagedPath);
    await syncDirectory(paths.staging);
  }
}

async function withIntentOperation<Result>(repository: string, operation: () => Promise<Result>): Promise<Result> {
  const key = resolve(repository);
  const previous = operations.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const current = previous.catch(() => undefined).then(() => gate);
  operations.set(key, current);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally {
    release?.();
    if (operations.get(key) === current) operations.delete(key);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); }
  finally { await directory.close(); }
}

function repositoryFromIntentDirectory(directory: string): string { return dirname(dirname(directory)); }
function assertIntentName(name: string, intent: DeliveryIntent): void {
  if (name !== `${deliveryIntentKey(intent)}.json`) throw new DeliveryIntentStoreError("authoritative delivery intent staging name is invalid");
}
function isCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
export class DeliveryIntentStoreError extends Error { readonly name = "DeliveryIntentStoreError"; }
