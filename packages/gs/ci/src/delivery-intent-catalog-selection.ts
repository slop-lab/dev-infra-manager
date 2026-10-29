import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";
import {
  completeCurrentDeliveryIntent,
  withCurrentDeliveryIntent,
  type DeliveryIntent
} from "./authoritative-native-delivery-intent-store.js";
import type { DeliveryIntentCursor } from "./delivery-intent-catalog.js";
import {
  resolveAuthoritativeNativeDeliveries,
  type AuthoritativeNativeDeliveryProvenance,
  type ResolvedAuthoritativeNativeDelivery
} from "./authoritative-native-delivery-selection.js";
import {
  readDeliveryMarker,
  type AuthoritativeNativeDeliveryMarker,
  type DeliveryMarkerPaths
} from "./delivery-marker-storage.js";

export type AuthoritativeNativePendingDelivery = {
  readonly createdAt: string;
  readonly event: ResolvedAuthoritativeNativeDelivery["event"];
  readonly eventDigest: string;
  readonly policyDigest: string;
  readonly intent: DeliveryIntent;
  readonly provenance: AuthoritativeNativeDeliveryProvenance;
};

export async function selectCatalogPendingDeliveries(input: {
  readonly repository: string;
  readonly paths: SelectionPaths;
  readonly cursor: DeliveryIntentCursor;
  readonly limit: number;
  readonly binding: AuthoritativeNativeDeliveryBinding;
  readonly generationId: string;
}): Promise<readonly AuthoritativeNativePendingDelivery[]> {
  if (input.cursor.kind === "unprimed") {
    return selectUnprimedDeliveries({ ...input, intents: input.cursor.intents });
  }
  const selected: AuthoritativeNativePendingDelivery[] = [];
  while (selected.length < input.limit) {
    const reviewIntents = input.cursor.nextGroup();
    if (reviewIntents.length === 0) break;
    const candidates = await resolveReviewIntents(input.repository, reviewIntents, input.binding);
    for (const candidate of candidates) {
      const marker = await readDeliveryMarker(input.paths, candidate);
      if (!await reconcileRecordedMarkerIntent({ paths: intentPaths(input.paths), intent: candidate.intent,
        marker, binding: input.binding, generationId: input.generationId })) {
        selected.push(candidate);
      }
      if (selected.length === input.limit) break;
    }
  }
  return selected.sort(compareDeliveries).slice(0, input.limit);
}

async function selectUnprimedDeliveries(input: {
  readonly repository: string;
  readonly paths: SelectionPaths;
  readonly intents: readonly DeliveryIntent[];
  readonly limit: number;
  readonly binding: AuthoritativeNativeDeliveryBinding;
  readonly generationId: string;
}): Promise<readonly AuthoritativeNativePendingDelivery[]> {
  const byReview = new Map<string, DeliveryIntent[]>();
  for (const intent of input.intents) {
    const reviewIntents = byReview.get(intent.reviewId) ?? [];
    reviewIntents.push(intent);
    byReview.set(intent.reviewId, reviewIntents);
  }
  const candidates: AuthoritativeNativePendingDelivery[] = [];
  for (const reviewIntents of byReview.values()) {
    for (const candidate of await resolveReviewIntents(input.repository, reviewIntents, input.binding)) {
      const marker = await readDeliveryMarker(input.paths, candidate);
      if (!await reconcileRecordedMarkerIntent({ paths: intentPaths(input.paths), intent: candidate.intent,
        marker, binding: input.binding, generationId: input.generationId })) {
        candidates.push(candidate);
      }
    }
  }
  return candidates.sort(compareDeliveries).slice(0, input.limit);
}

async function resolveReviewIntents(repository: string,
  intents: readonly DeliveryIntent[],
  binding: AuthoritativeNativeDeliveryBinding): Promise<readonly AuthoritativeNativePendingDelivery[]> {
  const resolved = await resolveAuthoritativeNativeDeliveries(repository, intents, binding);
  return resolved.map((delivery, index) => ({ ...delivery, intent: intents[index] }))
    .filter((candidate): candidate is AuthoritativeNativePendingDelivery => candidate.intent !== undefined)
    .sort(compareDeliveries);
}

function compareDeliveries(left: AuthoritativeNativePendingDelivery,
  right: AuthoritativeNativePendingDelivery): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.event.reviewId.localeCompare(right.event.reviewId)
    || left.event.checkName.localeCompare(right.event.checkName)
    || left.event.eventId.localeCompare(right.event.eventId);
}

export async function reconcileRecordedMarkerIntent(input: {
  readonly paths: IntentPaths;
  readonly intent: DeliveryIntent;
  readonly marker: AuthoritativeNativeDeliveryMarker | undefined;
  readonly binding: AuthoritativeNativeDeliveryBinding;
  readonly generationId: string;
}): Promise<boolean> {
  const marker = input.marker;
  if (marker === undefined || marker.state !== "recorded"
    || marker.eventId !== input.intent.eventId || marker.eventDigest !== input.intent.eventDigest
    || marker.serviceId !== input.intent.serviceId || marker.serviceId !== input.binding.serviceId
    || marker.destinationDigest !== input.intent.destinationDigest
    || marker.destinationDigest !== input.binding.destinationDigest
    || marker.generationId !== input.intent.generationId
    || marker.generationId !== input.generationId) return false;
  return withCurrentDeliveryIntent(input.paths, input.intent, async (current) => {
    if (current.state !== "completed") {
      await completeCurrentDeliveryIntent(input.paths, current, marker.executionId);
    }
    return true;
  });
}

type IntentPaths = { readonly intents: string; readonly staging: string };
type SelectionPaths = DeliveryMarkerPaths & {
  readonly intents: string;
  readonly intentStaging: string;
};

function intentPaths(paths: SelectionPaths): IntentPaths {
  return { intents: paths.intents, staging: paths.intentStaging };
}
