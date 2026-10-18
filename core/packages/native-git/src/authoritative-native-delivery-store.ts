import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  assertAuthoritativeNativeReviewStore,
  readAuthoritativeNativeReviewEnvelopes
} from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import {
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging,
  replaceReviewRecord,
  type ReviewPublicationFaults
} from "./review-record-storage.js";

const maximumEvents = 100_000;
const maximumMarkerBytes = 4 * 1024;
const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const markerBase = {
  schemaVersion: z.literal(3),
  eventId: z.string().regex(/^[0-9a-f]{64}$/),
  eventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  serviceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  destinationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/)
} as const;
const markerSchema = z.discriminatedUnion("state", [z.object({ ...markerBase, state: z.literal("recorded"),
  generationId: z.string().regex(/^[0-9a-f]{64}$/),
  executionId: z.string().uuid()
}).strict().readonly(), z.object({ ...markerBase, state: z.literal("superseded"),
  rejectionStatus: z.union([z.literal(404), z.literal(409)]), rejectedAt: z.number().int().positive(),
  retryAfter: z.number().int().positive()
}).strict().readonly()]);

export type AuthoritativeNativePendingDelivery = {
  readonly createdAt: string;
  readonly event: AuthoritativeNativeReviewEnvelope["events"][number];
  readonly eventDigest: string;
  readonly policyDigest: string;
};

export async function readPendingAuthoritativeNativeDeliveries(
  repository: string,
  limit: number,
  binding: AuthoritativeNativeDeliveryBinding,
  generationId: string,
  now = Date.now()
): Promise<readonly AuthoritativeNativePendingDelivery[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumEvents) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery enumeration bound is invalid");
  }
  if (!await reviewStoreExists(repository)) return [];
  const paths = await initializeDeliveryStore(repository);
  const envelopes = await readAuthoritativeNativeReviewEnvelopes(repository);
  const events = executionEvents(envelopes);
  const delivered = await readMarkers(paths.delivered, events, binding, generationId, now);
  return events.filter(({ event }) => !delivered.has(event.eventId)).slice(0, limit);
}

export async function acknowledgeAuthoritativeNativeDelivery(
  repository: string,
  delivery: AuthoritativeNativePendingDelivery,
  acknowledgement: { readonly serviceId: string; readonly generationId: string; readonly executionId: string },
  binding: AuthoritativeNativeDeliveryBinding,
  faults: ReviewPublicationFaults = {}
): Promise<z.infer<typeof markerSchema>> {
  const paths = await initializeDeliveryStore(repository);
  const stored = executionEvents(await readAuthoritativeNativeReviewEnvelopes(repository))
    .find(({ event }) => event.eventId === delivery.event.eventId);
  if (stored === undefined || stored.eventDigest !== delivery.eventDigest) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery event does not match stored review");
  }
  const marker = markerSchema.parse({ schemaVersion: 3, state: "recorded", eventId: delivery.event.eventId,
    eventDigest: delivery.eventDigest, serviceId: acknowledgement.serviceId,
    generationId: acknowledgement.generationId, destinationDigest: binding.destinationDigest,
    executionId: acknowledgement.executionId });
  const path = join(paths.delivered, `${marker.eventId}.json`);
  try {
    await publishReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`,
      stagingRoot: paths.staging, faults });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = markerSchema.parse(await readReviewJson(path, maximumMarkerBytes, true));
    if (existing.eventId !== marker.eventId || existing.eventDigest !== marker.eventDigest) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker conflicts with acknowledgement");
    }
    if (JSON.stringify(existing) !== JSON.stringify(marker)) await replaceReviewRecord({ path,
      serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
  }
  return marker;
}

export async function supersedeAuthoritativeNativeDelivery(repository: string,
  delivery: AuthoritativeNativePendingDelivery, binding: AuthoritativeNativeDeliveryBinding,
  rejectionStatus: 404 | 409, suppressionMilliseconds: number, faults: ReviewPublicationFaults = {}): Promise<void> {
  const paths = await initializeDeliveryStore(repository);
  const rejectedAt = Date.now();
  const marker = markerSchema.parse({ schemaVersion: 3, state: "superseded", eventId: delivery.event.eventId,
    eventDigest: delivery.eventDigest, serviceId: binding.serviceId, destinationDigest: binding.destinationDigest,
    rejectionStatus, rejectedAt, retryAfter: rejectedAt + suppressionMilliseconds });
  const path = join(paths.delivered, `${marker.eventId}.json`);
  try { await publishReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults }); }
  catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = markerSchema.parse(await readReviewJson(path, maximumMarkerBytes, true));
    if (existing.eventId !== marker.eventId || existing.eventDigest !== marker.eventDigest) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker conflicts with rejection");
    }
    await replaceReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
  }
}

async function initializeDeliveryStore(repository: string): Promise<DeliveryPaths> {
  await assertAuthoritativeNativeReviewStore(repository);
  const root = join(repository, "dim-authoritative-reviews");
  const paths = { delivered: join(root, "delivered"), staging: join(root, "delivery-staging") };
  await ownedReviewDirectory(paths.delivered);
  await ownedReviewDirectory(paths.staging);
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.delivered });
  return paths;
}

async function readMarkers(
  directory: string,
  events: readonly AuthoritativeNativePendingDelivery[],
  binding: AuthoritativeNativeDeliveryBinding,
  generationId: string,
  now: number
): Promise<ReadonlySet<string>> {
  const expected = new Map(events.map((delivery) => [delivery.event.eventId, delivery]));
  const delivered = new Set<string>();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumEvents) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker capacity is exceeded");
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker name is invalid");
    }
    const eventId = match[1];
    const marker = markerSchema.parse(await readReviewJson(join(directory, entry.name), maximumMarkerBytes, true));
    const event = eventId === undefined ? undefined : expected.get(eventId);
    if (event === undefined || marker.eventId !== eventId || marker.eventDigest !== event.eventDigest) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker does not match its event");
    }
    if (marker.serviceId === binding.serviceId && marker.destinationDigest === binding.destinationDigest
      && (marker.state === "superseded" ? marker.retryAfter > now : marker.generationId === generationId)) {
      delivered.add(eventId);
    }
  }
  return delivered;
}

function executionEvents(
  envelopes: readonly AuthoritativeNativeReviewEnvelope[]
): readonly AuthoritativeNativePendingDelivery[] {
  return envelopes.flatMap(({ review, events, policyDigest }) => events.map((event) => ({
    createdAt: review.createdAt, event, policyDigest,
    eventDigest: `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`
  }))).sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.event.reviewId.localeCompare(right.event.reviewId)
    || left.event.jobName.localeCompare(right.event.jobName)
    || left.event.eventId.localeCompare(right.event.eventId));
}

async function reviewStoreExists(repository: string): Promise<boolean> {
  try {
    await lstat(join(repository, "dim-authoritative-reviews"));
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

type DeliveryPaths = { readonly delivered: string; readonly staging: string };
export class AuthoritativeNativeDeliveryStoreError extends Error {
  readonly name = "AuthoritativeNativeDeliveryStoreError";
}
