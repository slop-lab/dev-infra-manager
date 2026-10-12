import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertAuthoritativeNativeReviewStore,
  readAuthoritativeNativeReviewEnvelopes } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import { ownedReviewDirectory, publishReviewRecord, readReviewJson,
  recoverPublishedReviewStaging, replaceReviewRecord,
  type ReviewPublicationFaults } from "./review-record-storage.js";

const maximumEvents = 100_000;
const maximumMarkerBytes = 4 * 1024;
const markerBase = { schemaVersion: z.literal(3), eventId: z.string().regex(/^[0-9a-f]{64}$/),
  eventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  serviceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  destinationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) } as const;
const markerSchema = z.discriminatedUnion("state", [z.object({ ...markerBase, state: z.literal("recorded"),
  serviceGenerationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  eligibilityGeneration: z.string().uuid(), eligibilityExpiresAt: z.number().int().positive() }).strict().readonly(),
  z.object({ ...markerBase, state: z.literal("superseded"),
    rejectionStatus: z.union([z.literal(404), z.literal(409)]),
    rejectedAt: z.number().int().positive(), retryAfter: z.number().int().positive() }).strict().readonly()]);

type QemuEvent = AuthoritativeNativeReviewEnvelope["events"][number] & { readonly executionKind: "qemu" };
export type AuthoritativeNativeQemuPendingDelivery = { readonly createdAt: string; readonly event: QemuEvent;
  readonly eventDigest: string; readonly policyDigest: string };

export async function readPendingAuthoritativeNativeQemuDeliveries(
  repository: string,
  limit: number,
  binding: AuthoritativeNativeDeliveryBinding,
  now = Date.now()
): Promise<readonly AuthoritativeNativeQemuPendingDelivery[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumEvents) {
    throw new AuthoritativeNativeQemuDeliveryStoreError("authoritative QEMU delivery enumeration bound is invalid");
  }
  if (!await reviewStoreExists(repository)) return [];
  const paths = await initialize(repository);
  const events = qemuEvents(await readAuthoritativeNativeReviewEnvelopes(repository));
  const delivered = await readMarkers(paths.delivered, events, binding, now);
  return events.filter(({ event }) => !delivered.has(event.eventId)).slice(0, limit);
}

export async function acknowledgeAuthoritativeNativeQemuDelivery(
  repository: string,
  delivery: AuthoritativeNativeQemuPendingDelivery,
  acknowledgement: { readonly serviceId: string; readonly serviceGenerationId: string;
    readonly eligibilityGeneration: string; readonly eligibilityExpiresAt: number },
  binding: AuthoritativeNativeDeliveryBinding,
  faults: ReviewPublicationFaults = {}
): Promise<z.infer<typeof markerSchema>> {
  const paths = await initialize(repository);
  const stored = qemuEvents(await readAuthoritativeNativeReviewEnvelopes(repository))
    .find(({ event }) => event.eventId === delivery.event.eventId);
  if (stored === undefined || stored.eventDigest !== delivery.eventDigest) {
    throw new AuthoritativeNativeQemuDeliveryStoreError("authoritative QEMU delivery does not match stored review");
  }
  const marker = markerSchema.parse({ schemaVersion: 3, state: "recorded", eventId: delivery.event.eventId,
    eventDigest: delivery.eventDigest, serviceId: acknowledgement.serviceId,
    serviceGenerationId: acknowledgement.serviceGenerationId, destinationDigest: binding.destinationDigest,
    eligibilityGeneration: acknowledgement.eligibilityGeneration,
    eligibilityExpiresAt: acknowledgement.eligibilityExpiresAt });
  const path = join(paths.delivered, `${marker.eventId}.json`);
  try {
    await publishReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = markerSchema.parse(await readReviewJson(path, maximumMarkerBytes, true));
    if (existing.eventId !== marker.eventId || existing.eventDigest !== marker.eventDigest) {
      throw new AuthoritativeNativeQemuDeliveryStoreError("authoritative QEMU delivery marker conflicts");
    }
    if (JSON.stringify(existing) !== JSON.stringify(marker)) await replaceReviewRecord({ path,
      serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
  }
  return marker;
}

export async function supersedeAuthoritativeNativeQemuDelivery(repository: string,
  delivery: AuthoritativeNativeQemuPendingDelivery, binding: AuthoritativeNativeDeliveryBinding,
  rejectionStatus: 404 | 409, suppressionMilliseconds: number, faults: ReviewPublicationFaults = {}): Promise<void> {
  const paths = await initialize(repository);
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
      throw new AuthoritativeNativeQemuDeliveryStoreError("authoritative QEMU marker conflicts with rejection");
    }
    await replaceReviewRecord({ path, serialized: `${JSON.stringify(marker)}\n`, stagingRoot: paths.staging, faults });
  }
}

async function initialize(repository: string): Promise<DeliveryPaths> {
  await assertAuthoritativeNativeReviewStore(repository);
  const root = join(repository, "dim-authoritative-reviews");
  const paths = { delivered: join(root, "qemu-delivered"), staging: join(root, "qemu-delivery-staging") };
  await ownedReviewDirectory(paths.delivered);
  await ownedReviewDirectory(paths.staging);
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.delivered });
  return paths;
}

async function readMarkers(
  directory: string,
  events: readonly AuthoritativeNativeQemuPendingDelivery[],
  binding: AuthoritativeNativeDeliveryBinding,
  now: number
): Promise<ReadonlySet<string>> {
  const expected = new Map(events.map((delivery) => [delivery.event.eventId, delivery]));
  const delivered = new Set<string>();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumEvents) {
    throw new AuthoritativeNativeQemuDeliveryStoreError("authoritative QEMU marker capacity is exceeded");
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new AuthoritativeNativeQemuDeliveryStoreError("authoritative QEMU marker name is invalid");
    }
    const eventId = match[1];
    const marker = markerSchema.parse(await readReviewJson(join(directory, entry.name), maximumMarkerBytes, true));
    const event = eventId === undefined ? undefined : expected.get(eventId);
    if (event === undefined || marker.eventId !== eventId || marker.eventDigest !== event.eventDigest) {
      throw new AuthoritativeNativeQemuDeliveryStoreError("authoritative QEMU marker does not match its event");
    }
    if (marker.serviceId === binding.serviceId && marker.destinationDigest === binding.destinationDigest
      && (marker.state === "superseded" ? marker.retryAfter > now : marker.eligibilityExpiresAt > now)) {
      delivered.add(eventId);
    }
  }
  return delivered;
}

function qemuEvents(
  envelopes: readonly AuthoritativeNativeReviewEnvelope[]
): readonly AuthoritativeNativeQemuPendingDelivery[] {
  return envelopes.flatMap(({ review, events, policyDigest }) => events.flatMap((event) => event.executionKind === "qemu"
    ? [{ createdAt: review.createdAt, event: { ...event, executionKind: "qemu" as const },
      policyDigest,
      eventDigest: `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}` }]
    : [])).sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.event.reviewId.localeCompare(right.event.reviewId)
    || left.event.jobName.localeCompare(right.event.jobName)
    || left.event.eventId.localeCompare(right.event.eventId));
}

async function reviewStoreExists(repository: string): Promise<boolean> {
  try { await lstat(join(repository, "dim-authoritative-reviews")); return true; }
  catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
type DeliveryPaths = { readonly delivered: string; readonly staging: string };
export class AuthoritativeNativeQemuDeliveryStoreError extends Error {
  readonly name = "AuthoritativeNativeQemuDeliveryStoreError";
}
