import { constants, type Stats } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ownedReviewDirectory,
  publishReviewRecord,
  replaceReviewRecord
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import type { CiDeliveryPublicationFaults } from "./delivery-publication.js";

const maximumEvents = 100_000;
const maximumMarkerBytes = 4 * 1024;
const markerBase = {
  schemaVersion: z.literal(3),
  eventId: z.string().regex(/^[0-9a-f]{64}$/),
  eventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  serviceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  destinationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/)
} as const;
const markerSchema = z.discriminatedUnion("state", [
  z.object({
    ...markerBase,
    state: z.literal("recorded"),
    generationId: z.string().regex(/^[0-9a-f]{64}$/),
    executionId: z.string().uuid()
  }).strict().readonly(),
  z.object({
    ...markerBase,
    state: z.literal("superseded"),
    rejectionStatus: z.union([z.literal(404), z.literal(409)]),
    rejectedAt: z.number().int().positive(),
    retryAfter: z.number().int().positive()
  }).strict().readonly()
]);
const operations = new Map<string, Promise<void>>();
const markerPattern = /^[0-9a-f]{64}\.json$/;
const stagingPattern = /^([0-9a-f]{64}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export type AuthoritativeNativeDeliveryMarker = z.infer<typeof markerSchema>;
export type DeliveryMarkerPaths = { readonly delivered: string; readonly staging: string };
type ExpectedDelivery = { readonly event: { readonly eventId: string }; readonly eventDigest: string };
type StoredMarker = { readonly marker: AuthoritativeNativeDeliveryMarker; readonly stat: Stats };

export function parseAuthoritativeNativeDeliveryMarker(value: unknown): AuthoritativeNativeDeliveryMarker {
  return markerSchema.parse(value);
}

export async function withDeliveryMarkerOperation<Result>(
  repository: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const key = resolve(repository);
  const previous = operations.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const current = previous.catch(() => undefined).then(() => gate);
  operations.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (operations.get(key) === current) operations.delete(key);
  }
}

export async function initializeDeliveryMarkerStorage(repository: string): Promise<DeliveryMarkerPaths> {
  const root = join(repository, "dim-git-ci-deliveries");
  const paths = { delivered: join(root, "delivered"), staging: join(root, "delivery-staging") };
  await ownedReviewDirectory(root);
  await syncDirectory(repository);
  await ownedReviewDirectory(paths.delivered);
  await ownedReviewDirectory(paths.staging);
  await syncDirectory(root);
  await recoverMarkerStaging(paths);
  return paths;
}

export async function readDeliveryMarkers(
  paths: DeliveryMarkerPaths,
  events: readonly ExpectedDelivery[]
): Promise<ReadonlyMap<string, AuthoritativeNativeDeliveryMarker>> {
  const expected = new Map(events.map((delivery) => [delivery.event.eventId, delivery]));
  const markers = new Map<string, AuthoritativeNativeDeliveryMarker>();
  const entries = (await readdir(paths.delivered, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > maximumEvents) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker capacity is exceeded");
  }
  for (const entry of entries) {
    if (!entry.isFile() || !markerPattern.test(entry.name)) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker name is invalid");
    }
    const stored = await readStoredMarker(join(paths.delivered, entry.name));
    if (stored.stat.nlink !== 1) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker must be a single-link file");
    }
    const event = expected.get(stored.marker.eventId);
    if (entry.name !== `${stored.marker.eventId}.json` || event === undefined
      || stored.marker.eventDigest !== event.eventDigest) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker does not match its event");
    }
    markers.set(stored.marker.eventId, stored.marker);
  }
  return markers;
}

export async function storeDeliveryMarker(
  paths: DeliveryMarkerPaths,
  marker: AuthoritativeNativeDeliveryMarker,
  faults: CiDeliveryPublicationFaults
): Promise<void> {
  const path = join(paths.delivered, `${marker.eventId}.json`);
  const existing = await readStoredMarkerIfPresent(path);
  if (existing !== undefined) {
    assertCanonicalMarker(existing, marker);
    if (JSON.stringify(existing.marker) !== JSON.stringify(marker)) {
      await replaceReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
    }
    return;
  }
  const entries = await readdir(paths.delivered, { withFileTypes: true });
  if (entries.length >= maximumEvents) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker capacity is exceeded");
  }
  try {
    await publishReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const raced = await readStoredMarker(path);
    assertCanonicalMarker(raced, marker);
    if (JSON.stringify(raced.marker) !== JSON.stringify(marker)) {
      await replaceReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
    }
  }
}

async function recoverMarkerStaging(paths: DeliveryMarkerPaths): Promise<void> {
  const entries = (await readdir(paths.staging, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const match = stagingPattern.exec(entry.name);
    if (!entry.isFile() || match === null || match[1] === undefined) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker staging entry is invalid");
    }
    const finalName = match[1];
    const stagedPath = join(paths.staging, entry.name);
    const finalPath = join(paths.delivered, finalName);
    const staged = await readStoredMarker(stagedPath);
    assertMarkerName(finalName, staged.marker);
    if (staged.stat.nlink === 2) {
      const final = await readStoredMarker(finalPath);
      assertMarkerName(finalName, final.marker);
      if (!sameIdentity(staged.marker, final.marker) || final.stat.nlink !== 2
        || staged.stat.dev !== final.stat.dev || staged.stat.ino !== final.stat.ino) {
        throw new AuthoritativeNativeDeliveryStoreError("published delivery marker staging identity is invalid");
      }
    } else if (staged.stat.nlink === 1) {
      const final = await readStoredMarkerIfPresent(finalPath);
      if (final !== undefined) {
        assertMarkerName(finalName, final.marker);
        if (!sameIdentity(staged.marker, final.marker) || final.stat.nlink !== 1
          || staged.stat.dev === final.stat.dev && staged.stat.ino === final.stat.ino) {
          throw new AuthoritativeNativeDeliveryStoreError("replacement delivery marker staging identity is invalid");
        }
      }
    } else {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker staging link count is invalid");
    }
    await unlink(stagedPath);
    await syncDirectory(paths.staging);
  }
}

async function readStoredMarker(path: string): Promise<StoredMarker> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker must be a caller-owned mode-0600 regular file");
    }
    if (stat.size > maximumMarkerBytes) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker exceeds its storage bound");
    }
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    return { marker: parseAuthoritativeNativeDeliveryMarker(value), stat };
  } finally {
    await file.close();
  }
}

async function readStoredMarkerIfPresent(path: string): Promise<StoredMarker | undefined> {
  try {
    return await readStoredMarker(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertCanonicalMarker(existing: StoredMarker, candidate: AuthoritativeNativeDeliveryMarker): void {
  if (existing.stat.nlink !== 1 || !sameIdentity(existing.marker, candidate)) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker conflicts with update");
  }
}

function assertMarkerName(name: string, marker: AuthoritativeNativeDeliveryMarker): void {
  if (name !== `${marker.eventId}.json`) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker staging name is invalid");
  }
}

function sameIdentity(left: AuthoritativeNativeDeliveryMarker, right: AuthoritativeNativeDeliveryMarker): boolean {
  return left.eventId === right.eventId && left.eventDigest === right.eventDigest;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery markers require a Linux user identity");
  }
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AuthoritativeNativeDeliveryStoreError extends Error {
  readonly name = "AuthoritativeNativeDeliveryStoreError";
}
