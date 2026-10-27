import type { CiDeliveryPublicationFaults } from "./delivery-publication.js";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  assertAuthoritativeNativeReviewStore,
  readAuthoritativeNativeReviewEnvelopes
} from "./plan-store.js";
import type { AuthoritativeNativeReviewEnvelope } from "./plan-schema.js";
import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import { completeDeliveryIntent, initializeDeliveryIntentStore, readExplicitDeliveryIntents,
  supersedeDeliveryIntent, type DeliveryIntent } from "./authoritative-native-delivery-intent-store.js";
export { recordExplicitAuthoritativeNativeDeliveryIntent } from "./authoritative-native-delivery-intent-store.js";
import {
  AuthoritativeNativeDeliveryStoreError,
  initializeDeliveryMarkerStorage,
  parseAuthoritativeNativeDeliveryMarker,
  readDeliveryMarkers,
  storeDeliveryMarker,
  withDeliveryMarkerOperation,
  type AuthoritativeNativeDeliveryMarker,
  type DeliveryMarkerPaths
} from "./delivery-marker-storage.js";
export { AuthoritativeNativeDeliveryStoreError } from "./delivery-marker-storage.js";

const maximumEvents = 100_000;

export type AuthoritativeNativePendingDelivery = {
  readonly createdAt: string;
  readonly event: AuthoritativeNativeReviewEnvelope["events"][number];
  readonly eventDigest: string;
  readonly policyDigest: string;
  readonly intent?: DeliveryIntent;
};

export async function readPendingAuthoritativeNativeDeliveries(
  repository: string,
  limit: number,
  binding: AuthoritativeNativeDeliveryBinding,
  generationId: string,
  now = Date.now()
): Promise<readonly AuthoritativeNativePendingDelivery[]> {
  return withDeliveryMarkerOperation(repository,
    () => readPendingUnlocked(repository, limit, binding, generationId, now));
}

async function readPendingUnlocked(repository: string, limit: number,
  binding: AuthoritativeNativeDeliveryBinding, generationId: string,
  now: number): Promise<readonly AuthoritativeNativePendingDelivery[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumEvents) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery enumeration bound is invalid");
  }
  if (!await reviewStoreExists(repository)) return [];
  const paths = await initializeDeliveryStoreUnlocked(repository);
  const envelopes = await readAuthoritativeNativeReviewEnvelopes(repository);
  const events = executionEvents(envelopes);
  const markers = await readDeliveryMarkers(paths, events);
  const intents = await readExplicitDeliveryIntents(paths.intents, events, binding, generationId);
  return events.flatMap((delivery) => {
    const marker = markers.get(delivery.event.eventId), intent = intents.get(delivery.event.eventId);
    if (intent === undefined) return [];
    if (intent.state === "completed" || intent.state === "superseded" && intent.retryAfter > now) return [];
    if (marker?.serviceId === binding.serviceId && marker.destinationDigest === binding.destinationDigest) {
      if (marker.state === "superseded" && marker.retryAfter > now) return [];
      if (marker.state === "recorded" && marker.generationId === generationId) return [];
    }
    return [{ ...delivery, intent }];
  }).slice(0, limit);
}

export async function acknowledgeAuthoritativeNativeDelivery(
  repository: string,
  delivery: AuthoritativeNativePendingDelivery,
  acknowledgement: { readonly serviceId: string; readonly generationId: string; readonly executionId: string },
  binding: AuthoritativeNativeDeliveryBinding,
  faults: CiDeliveryPublicationFaults = {}
): Promise<AuthoritativeNativeDeliveryMarker> {
  return withDeliveryMarkerOperation(repository,
    () => acknowledgeUnlocked(repository, delivery, acknowledgement, binding, faults));
}

async function acknowledgeUnlocked(repository: string, delivery: AuthoritativeNativePendingDelivery,
  acknowledgement: { readonly serviceId: string; readonly generationId: string; readonly executionId: string },
  binding: AuthoritativeNativeDeliveryBinding,
  faults: CiDeliveryPublicationFaults): Promise<AuthoritativeNativeDeliveryMarker> {
  const paths = await initializeDeliveryStoreUnlocked(repository);
  const stored = executionEvents(await readAuthoritativeNativeReviewEnvelopes(repository))
    .find(({ event }) => event.eventId === delivery.event.eventId);
  if (stored === undefined || stored.eventDigest !== delivery.eventDigest) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery event does not match stored review");
  }
  if (delivery.intent !== undefined && (delivery.intent.generationId !== acknowledgement.generationId
    || delivery.intent.serviceId !== binding.serviceId || delivery.intent.destinationDigest !== binding.destinationDigest)) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery acknowledgement conflicts with explicit intent");
  }
  const marker = parseAuthoritativeNativeDeliveryMarker({ schemaVersion: 3, state: "recorded", eventId: delivery.event.eventId,
    eventDigest: delivery.eventDigest, serviceId: acknowledgement.serviceId,
    generationId: acknowledgement.generationId, destinationDigest: binding.destinationDigest,
    executionId: acknowledgement.executionId });
  await storeDeliveryMarker(paths, marker, faults);
  if (delivery.intent !== undefined) await completeDeliveryIntent({ intents: paths.intents, staging: paths.intentStaging }, delivery.intent, acknowledgement.executionId);
  return marker;
}

export async function supersedeAuthoritativeNativeDelivery(repository: string,
  delivery: AuthoritativeNativePendingDelivery, binding: AuthoritativeNativeDeliveryBinding,
  rejectionStatus: 404 | 409, suppressionMilliseconds: number, faults: CiDeliveryPublicationFaults = {}): Promise<void> {
  await withDeliveryMarkerOperation(repository,
    () => supersedeUnlocked(repository, delivery, binding, rejectionStatus, suppressionMilliseconds, faults));
}

async function supersedeUnlocked(repository: string, delivery: AuthoritativeNativePendingDelivery,
  binding: AuthoritativeNativeDeliveryBinding, rejectionStatus: 404 | 409,
  suppressionMilliseconds: number, faults: CiDeliveryPublicationFaults): Promise<void> {
  const paths = await initializeDeliveryStoreUnlocked(repository);
  const rejectedAt = Date.now();
  if (delivery.intent !== undefined) {
    await supersedeDeliveryIntent({ intents: paths.intents, staging: paths.intentStaging }, delivery.intent, rejectionStatus, rejectedAt, rejectedAt + suppressionMilliseconds);
    return;
  }
  const marker = parseAuthoritativeNativeDeliveryMarker({ schemaVersion: 3, state: "superseded", eventId: delivery.event.eventId,
    eventDigest: delivery.eventDigest, serviceId: binding.serviceId, destinationDigest: binding.destinationDigest,
    rejectionStatus, rejectedAt, retryAfter: rejectedAt + suppressionMilliseconds });
  await storeDeliveryMarker(paths, marker, faults);
}

async function initializeDeliveryStoreUnlocked(repository: string): Promise<DeliveryPaths> {
  await assertAuthoritativeNativeReviewStore(repository);
  const intent = await initializeDeliveryIntentStore(repository);
  const marker = await initializeDeliveryMarkerStorage(repository);
  return { ...marker, intents: intent.intents, intentStaging: intent.staging };
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

type DeliveryPaths = DeliveryMarkerPaths & { readonly intents: string; readonly intentStaging: string };
