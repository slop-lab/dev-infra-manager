import type { CiDeliveryPublicationFaults } from "./delivery-publication.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import {
  completeCurrentDeliveryIntent,
  initializeDeliveryIntentStore,
  readSelectableDeliveryIntents,
  supersedeCurrentDeliveryIntent,
  withCurrentDeliveryIntent,
  type DeliveryIntent
} from "./authoritative-native-delivery-intent-store.js";
export { recordExplicitAuthoritativeNativeDeliveryIntent } from "./authoritative-native-delivery-intent-store.js";
import {
  AuthoritativeNativeDeliveryStoreError,
  auditDeliveryMarkers,
  initializeDeliveryMarkerStorage,
  parseAuthoritativeNativeDeliveryMarker,
  readDeliveryMarker,
  storeDeliveryMarker,
  withDeliveryMarkerOperation,
  type AuthoritativeNativeDeliveryMarker,
  type DeliveryMarkerPaths
} from "./delivery-marker-storage.js";
export { AuthoritativeNativeDeliveryStoreError } from "./delivery-marker-storage.js";
import {
  resolveAuthoritativeNativeDelivery,
  readVerifiedAuthoritativeNativeDeliveryEvents,
  sameAuthoritativeNativeDelivery,
  type AuthoritativeNativeDeliveryProvenance,
  type ResolvedAuthoritativeNativeDelivery
} from "./authoritative-native-delivery-selection.js";

const maximumEvents = 100_000;

export type AuthoritativeNativePendingDelivery = {
  readonly createdAt: string;
  readonly event: ResolvedAuthoritativeNativeDelivery["event"];
  readonly eventDigest: string;
  readonly policyDigest: string;
  readonly intent: DeliveryIntent;
  readonly provenance: AuthoritativeNativeDeliveryProvenance;
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
  if (!await deliveryHistoryExists(repository)) return [];
  const paths = await initializeDeliveryStoreUnlocked(repository);
  const intents = await readSelectableDeliveryIntents(paths.intents, binding, generationId, now);
  if (intents.length === 0) return [];
  const candidates = await Promise.all(intents.map(async (intent) => {
    const delivery = await resolveAuthoritativeNativeDelivery(repository, intent);
    const marker = await readDeliveryMarker(paths, delivery);
    if (markerSuppressesCurrentIntent(marker, binding, generationId)) return undefined;
    return { ...delivery, intent };
  }));
  return candidates.filter((candidate): candidate is AuthoritativeNativePendingDelivery => candidate !== undefined)
    .sort(compareDeliveries).slice(0, limit);
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
  if (delivery.intent.generationId !== acknowledgement.generationId
    || acknowledgement.serviceId !== binding.serviceId
    || delivery.intent.serviceId !== binding.serviceId
    || delivery.intent.destinationDigest !== binding.destinationDigest) {
    throw new AuthoritativeNativeDeliveryStoreError("authoritative delivery acknowledgement conflicts with explicit intent");
  }
  return withCurrentDeliveryIntent(intentPaths(paths), delivery.intent, async (current) => {
    const stored = await resolveAuthoritativeNativeDelivery(repository, current);
    if (!sameAuthoritativeNativeDelivery(delivery, stored)) {
      throw new AuthoritativeNativeDeliveryStoreError(
        "authoritative delivery provenance changed before acknowledgement"
      );
    }
    const marker = parseAuthoritativeNativeDeliveryMarker({ schemaVersion: 3, state: "recorded",
      eventId: stored.event.eventId, eventDigest: stored.eventDigest, serviceId: acknowledgement.serviceId,
      generationId: acknowledgement.generationId, destinationDigest: binding.destinationDigest,
      executionId: acknowledgement.executionId });
    await storeDeliveryMarker(paths, marker, faults);
    await completeCurrentDeliveryIntent(intentPaths(paths), current, acknowledgement.executionId);
    return marker;
  });
}

export async function supersedeAuthoritativeNativeDelivery(repository: string,
  delivery: AuthoritativeNativePendingDelivery, binding: AuthoritativeNativeDeliveryBinding,
  rejectionStatus: 404 | 409, suppressionMilliseconds: number): Promise<void> {
  await withDeliveryMarkerOperation(repository,
    () => supersedeUnlocked(repository, delivery, binding, rejectionStatus, suppressionMilliseconds));
}

async function supersedeUnlocked(repository: string, delivery: AuthoritativeNativePendingDelivery,
  binding: AuthoritativeNativeDeliveryBinding, rejectionStatus: 404 | 409,
  suppressionMilliseconds: number): Promise<void> {
  const paths = await initializeDeliveryStoreUnlocked(repository);
  const rejectedAt = Date.now();
  if (delivery.intent.serviceId !== binding.serviceId
    || delivery.intent.destinationDigest !== binding.destinationDigest) {
    throw new AuthoritativeNativeDeliveryStoreError(
      "authoritative delivery supersession conflicts with explicit intent"
    );
  }
  await withCurrentDeliveryIntent(intentPaths(paths), delivery.intent, async (current) => {
    const stored = await resolveAuthoritativeNativeDelivery(repository, current);
    if (!sameAuthoritativeNativeDelivery(delivery, stored)) {
      throw new AuthoritativeNativeDeliveryStoreError(
        "authoritative delivery provenance changed before supersession"
      );
    }
    const retryAfter = rejectedAt + suppressionMilliseconds;
    await supersedeCurrentDeliveryIntent(intentPaths(paths), current, rejectionStatus, rejectedAt, retryAfter);
  });
}

export async function auditAuthoritativeNativeDeliveryOutbox(repository: string,
  binding: AuthoritativeNativeDeliveryBinding, generationId: string): Promise<void> {
  await withDeliveryMarkerOperation(repository, async () => {
    if (!await deliveryHistoryExists(repository)) return;
    const paths = await initializeDeliveryStoreUnlocked(repository);
    await readSelectableDeliveryIntents(paths.intents, binding, generationId, Date.now());
    await auditDeliveryMarkers(paths, await readVerifiedAuthoritativeNativeDeliveryEvents(repository));
  });
}

async function initializeDeliveryStoreUnlocked(repository: string): Promise<DeliveryPaths> {
  const intent = await initializeDeliveryIntentStore(repository);
  const marker = await initializeDeliveryMarkerStorage(repository);
  return { ...marker, intents: intent.intents, intentStaging: intent.staging };
}


function compareDeliveries(left: AuthoritativeNativePendingDelivery,
  right: AuthoritativeNativePendingDelivery): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.event.reviewId.localeCompare(right.event.reviewId)
    || left.event.jobName.localeCompare(right.event.jobName)
    || left.event.eventId.localeCompare(right.event.eventId);
}

function markerSuppressesCurrentIntent(marker: AuthoritativeNativeDeliveryMarker | undefined,
  binding: AuthoritativeNativeDeliveryBinding, generationId: string): boolean {
  if (marker === undefined || marker.serviceId !== binding.serviceId
    || marker.destinationDigest !== binding.destinationDigest) return false;
  switch (marker.state) {
    case "recorded":
      return marker.generationId === generationId;
    case "superseded":
      return false;
  }
}

async function deliveryHistoryExists(repository: string): Promise<boolean> {
  for (const directory of ["dim-authoritative-reviews", "dim-git-ci-deliveries"]) {
    try {
      await lstat(join(repository, directory));
      return true;
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
  return false;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

type DeliveryPaths = DeliveryMarkerPaths & { readonly intents: string; readonly intentStaging: string };
function intentPaths(paths: DeliveryPaths) {
  return { intents: paths.intents, staging: paths.intentStaging };
}
