import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ownedReviewDirectory, publishReviewRecord, readReviewJson, replaceReviewRecord } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import type { AuthoritativeNativeReviewEnvelope } from "./plan-schema.js";
import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";

const maximumEvents = 100_000;
const maximumBytes = 4 * 1024;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const intentBase = { schemaVersion: z.literal(1), eventId: z.string().regex(/^[0-9a-f]{64}$/), eventDigest: digest,
  reviewId: z.string().regex(/^[0-9a-f]{64}$/), envelopeId: z.string().regex(/^[0-9a-f]{64}$/),
  generationId: z.string().regex(/^[0-9a-f]{64}$/), serviceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  destinationDigest: digest, ownerRequestId: z.string().min(1).max(256) } as const;
const intentSchema = z.discriminatedUnion("state", [
  z.object({ ...intentBase, state: z.literal("pending") }).strict().readonly(),
  z.object({ ...intentBase, state: z.literal("completed"), executionId: z.string().uuid() }).strict().readonly(),
  z.object({ ...intentBase, state: z.literal("superseded"), rejectionStatus: z.union([z.literal(404), z.literal(409)]),
    rejectedAt: z.number().int().positive(), retryAfter: z.number().int().positive() }).strict().readonly(),
]);
export type DeliveryIntent = z.infer<typeof intentSchema>;
type Event = AuthoritativeNativeReviewEnvelope["events"][number];
type Pending = { readonly event: Event; readonly eventDigest: string };
type IntentPaths = { readonly intents: string; readonly staging: string };
type StoredIntent = { readonly intent: DeliveryIntent; readonly stat: Stats };
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
    const intent = intentSchema.parse({ schemaVersion: 1, state: "pending", eventId: event.eventId, eventDigest,
      reviewId: envelope.review.reviewId, envelopeId: envelope.envelopeId, generationId, serviceId: binding.serviceId,
      destinationDigest: binding.destinationDigest, ownerRequestId });
    return { intent, name: `${intentKey(intent)}.json` };
  });
  for (const candidate of candidates) {
    if (!existingNames.has(candidate.name)) continue;
    const existing = intentSchema.parse(await readReviewJson(join(paths.intents, candidate.name), maximumBytes, true));
    if (!sameIdentity(existing, candidate.intent)) throw new DeliveryIntentStoreError("authoritative delivery intent conflicts");
  }
  const novel = candidates.filter(({ name }) => !existingNames.has(name));
  if (entries.length + novel.length > maximumEvents) {
    throw new DeliveryIntentStoreError("authoritative delivery intent capacity is exceeded");
  }
  for (const candidate of novel) {
    const path = join(paths.intents, candidate.name);
    try { await publishReviewRecord({ path, serialized: `${JSON.stringify(candidate.intent)}\n`, stagingRoot: paths.staging, faults: {} }); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const existing = intentSchema.parse(await readReviewJson(path, maximumBytes, true));
      if (!sameIdentity(existing, candidate.intent)) throw new DeliveryIntentStoreError("authoritative delivery intent conflicts");
    }
  }
}

export async function readExplicitDeliveryIntents(directory: string, events: readonly Pending[],
  binding: AuthoritativeNativeDeliveryBinding, generationId: string): Promise<ReadonlyMap<string, DeliveryIntent>> {
  return withIntentOperation(repositoryFromIntentDirectory(directory),
    () => readExplicitUnlocked(directory, events, binding, generationId));
}

async function readExplicitUnlocked(directory: string, events: readonly Pending[],
  binding: AuthoritativeNativeDeliveryBinding, generationId: string): Promise<ReadonlyMap<string, DeliveryIntent>> {
  const expected = new Map(events.map((delivery) => [delivery.event.eventId, delivery]));
  const intents = new Map<string, DeliveryIntent>();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumEvents) throw new DeliveryIntentStoreError("authoritative delivery intent capacity is exceeded");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !recordPattern.test(entry.name)) throw new DeliveryIntentStoreError("authoritative delivery intent name is invalid");
    const intent = intentSchema.parse(await readReviewJson(join(directory, entry.name), maximumBytes, true));
    const event = expected.get(intent.eventId);
    if (event === undefined || event.eventDigest !== intent.eventDigest || intent.reviewId !== event.event.reviewId
      || intent.envelopeId !== event.event.envelopeId || entry.name !== `${intentKey(intent)}.json`) {
      throw new DeliveryIntentStoreError("authoritative delivery intent does not match its event");
    }
    if (intent.generationId === generationId && intent.serviceId === binding.serviceId && intent.destinationDigest === binding.destinationDigest) intents.set(intent.eventId, intent);
  }
  return intents;
}

export async function completeDeliveryIntent(paths: IntentPaths,
  previous: DeliveryIntent, executionId: string): Promise<void> {
  await withIntentOperation(repositoryFromIntentDirectory(paths.intents), () => replaceIntentUnlocked(paths, previous,
    intentSchema.parse({ ...identity(previous), state: "completed", executionId })));
}
export async function supersedeDeliveryIntent(paths: IntentPaths,
  previous: DeliveryIntent, rejectionStatus: 404 | 409, rejectedAt: number, retryAfter: number): Promise<void> {
  await withIntentOperation(repositoryFromIntentDirectory(paths.intents), () => replaceIntentUnlocked(paths, previous,
    intentSchema.parse({ ...identity(previous), state: "superseded", rejectionStatus, rejectedAt, retryAfter })));
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
  if (!sameIdentity(previous, next)) throw new DeliveryIntentStoreError("authoritative delivery intent identity changed");
  await replaceReviewRecord({ path: join(paths.intents, `${intentKey(previous)}.json`), serialized: `${JSON.stringify(next)}\n`, stagingRoot: paths.staging, faults: {} });
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
    const staged = await readStoredIntent(stagedPath);
    assertIntentName(finalName, staged.intent);
    if (staged.stat.nlink === 2) {
      const final = await readStoredIntent(finalPath);
      assertIntentName(finalName, final.intent);
      if (!sameIdentity(staged.intent, final.intent) || final.stat.nlink !== 2
        || staged.stat.dev !== final.stat.dev || staged.stat.ino !== final.stat.ino) {
        throw new DeliveryIntentStoreError("published delivery intent staging identity is invalid");
      }
    } else if (staged.stat.nlink === 1) {
      const final = await readStoredIntentIfPresent(finalPath);
      if (final !== undefined) {
        assertIntentName(finalName, final.intent);
        if (!sameIdentity(staged.intent, final.intent) || final.stat.nlink !== 1
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

async function readStoredIntent(path: string): Promise<StoredIntent> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600) {
      throw new DeliveryIntentStoreError("authoritative delivery intent must be a caller-owned mode-0600 regular file");
    }
    if (stat.size > maximumBytes) throw new DeliveryIntentStoreError("authoritative delivery intent exceeds its storage bound");
    return { intent: intentSchema.parse(JSON.parse(await file.readFile("utf8"))), stat };
  } finally {
    await file.close();
  }
}

async function readStoredIntentIfPresent(path: string): Promise<StoredIntent | undefined> {
  try { return await readStoredIntent(path); }
  catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
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
  if (name !== `${intentKey(intent)}.json`) throw new DeliveryIntentStoreError("authoritative delivery intent staging name is invalid");
}
function intentKey(intent: Pick<DeliveryIntent, "eventId" | "generationId" | "serviceId" | "destinationDigest">): string {
  return createHash("sha256").update(JSON.stringify([intent.eventId, intent.generationId, intent.serviceId, intent.destinationDigest])).digest("hex");
}
function sameIdentity(left: DeliveryIntent, right: DeliveryIntent): boolean {
  return left.eventId === right.eventId && left.eventDigest === right.eventDigest && left.reviewId === right.reviewId
    && left.envelopeId === right.envelopeId && left.generationId === right.generationId && left.serviceId === right.serviceId
    && left.destinationDigest === right.destinationDigest;
}
function identity(intent: DeliveryIntent) {
  return { schemaVersion: 1 as const, eventId: intent.eventId, eventDigest: intent.eventDigest, reviewId: intent.reviewId,
    envelopeId: intent.envelopeId, generationId: intent.generationId, serviceId: intent.serviceId,
    destinationDigest: intent.destinationDigest, ownerRequestId: intent.ownerRequestId };
}
function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new DeliveryIntentStoreError("authoritative delivery intents require a Linux user identity");
  return uid;
}
function isCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
export class DeliveryIntentStoreError extends Error { readonly name = "DeliveryIntentStoreError"; }
