import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  assertAuthoritativeNativeReviewStore,
  readAuthoritativeNativeReviewEnvelopes
} from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import {
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging,
  type ReviewPublicationFaults
} from "./review-record-storage.js";

const maximumEvents = 100_000;
const maximumMarkerBytes = 4 * 1024;
const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const markerSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^[0-9a-f]{64}$/),
  eventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  admissionGeneration: uuidV4
}).strict().readonly();

type OrdinaryEvent = AuthoritativeNativeReviewEnvelope["events"][number] & {
  readonly executionKind: "ordinary-sysbox";
};
export type AuthoritativeNativePendingDelivery = {
  readonly createdAt: string;
  readonly event: OrdinaryEvent;
  readonly eventDigest: string;
  readonly policyDigest: string;
};

export async function readPendingAuthoritativeNativeDeliveries(
  repository: string,
  limit: number
): Promise<readonly AuthoritativeNativePendingDelivery[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumEvents) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery enumeration bound is invalid");
  }
  if (!await reviewStoreExists(repository)) return [];
  const paths = await initializeDeliveryStore(repository);
  const envelopes = await readAuthoritativeNativeReviewEnvelopes(repository);
  const events = ordinaryEvents(envelopes);
  const delivered = await readMarkers(paths.delivered, events);
  return events.filter(({ event }) => !delivered.has(event.eventId)).slice(0, limit);
}

export async function acknowledgeAuthoritativeNativeDelivery(
  repository: string,
  delivery: AuthoritativeNativePendingDelivery,
  admissionGeneration: string,
  faults: ReviewPublicationFaults = {}
): Promise<z.infer<typeof markerSchema>> {
  const paths = await initializeDeliveryStore(repository);
  const stored = ordinaryEvents(await readAuthoritativeNativeReviewEnvelopes(repository))
    .find(({ event }) => event.eventId === delivery.event.eventId);
  if (stored === undefined || stored.eventDigest !== delivery.eventDigest) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery event does not match stored review");
  }
  const marker = markerSchema.parse({ schemaVersion: 1, eventId: delivery.event.eventId,
    eventDigest: delivery.eventDigest, admissionGeneration });
  const path = join(paths.delivered, `${marker.eventId}.json`);
  try {
    await publishReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`,
      stagingRoot: paths.staging, faults });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = markerSchema.parse(await readReviewJson(path, maximumMarkerBytes, true));
    if (JSON.stringify(existing) !== JSON.stringify(marker)) {
      throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery marker conflicts with acknowledgement");
    }
  }
  return marker;
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
  events: readonly AuthoritativeNativePendingDelivery[]
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
    delivered.add(eventId);
  }
  return delivered;
}

function ordinaryEvents(
  envelopes: readonly AuthoritativeNativeReviewEnvelope[]
): readonly AuthoritativeNativePendingDelivery[] {
  return envelopes.flatMap(({ review, events }) => events.flatMap((event) => event.executionKind === "ordinary-sysbox"
    ? [{ createdAt: review.createdAt, event: { ...event, executionKind: "ordinary-sysbox" as const }, policyDigest: review.policyDigest,
      eventDigest: `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}` }]
    : [])).sort((left, right) => left.createdAt.localeCompare(right.createdAt)
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
