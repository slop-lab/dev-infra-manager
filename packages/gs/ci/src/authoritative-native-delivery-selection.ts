import { createHash } from "node:crypto";
import {
  assertVerifiedCiReviewSourceCurrent,
  readVerifiedCiReviewSources,
  type VerifiedCiReviewSource
} from "@slop-lab/gs-review/dim-legacy-provenance";
import {
  readVerifiedGitCiDeliveryProjection,
  type VerifiedGitCiDeliveryProjection
} from "./plan-store.js";
import type { DeliveryIntent } from "./delivery-intent-record.js";
import { AuthoritativeNativeDeliveryStoreError } from "./delivery-marker-storage.js";
import type { AuthoritativeNativeDeliveryBinding } from "./authoritative-native-delivery-binding.js";

export type AuthoritativeNativeDeliveryProvenance = {
  readonly sourceVersions: readonly string[];
};

export type ResolvedAuthoritativeNativeDelivery = {
  readonly createdAt: string;
  readonly event: VerifiedGitCiDeliveryProjection["events"][number];
  readonly eventDigest: string;
  readonly policyDigest: string;
  readonly provenance: AuthoritativeNativeDeliveryProvenance;
};

export type VerifiedAuthoritativeNativeDeliveryEvent = {
  readonly createdAt: string;
  readonly event: VerifiedGitCiDeliveryProjection["events"][number];
  readonly eventDigest: string;
  readonly policyDigest: string;
  readonly provenance: AuthoritativeNativeDeliveryProvenance;
};

type ProjectionVariant = {
  readonly projection: VerifiedGitCiDeliveryProjection;
  readonly sources: readonly VerifiedCiReviewSource[];
};

export async function resolveAuthoritativeNativeDelivery(
  repository: string,
  intent: DeliveryIntent,
  binding: AuthoritativeNativeDeliveryBinding,
): Promise<ResolvedAuthoritativeNativeDelivery> {
  const resolved = await resolveAuthoritativeNativeDeliveries(repository, [intent], binding);
  const delivery = resolved[0];
  if (delivery === undefined) {
    throw new AuthoritativeNativeDeliveryStoreError(
      "authoritative delivery intent has no exact verified Git CI projection"
    );
  }
  return delivery;
}

export async function resolveAuthoritativeNativeDeliveries(
  repository: string,
  intents: readonly DeliveryIntent[],
  binding: AuthoritativeNativeDeliveryBinding,
): Promise<readonly ResolvedAuthoritativeNativeDelivery[]> {
  if (intents.length === 0) return [];
  const reviewId = intents[0]?.reviewId;
  if (reviewId === undefined || intents.some((intent) => intent.reviewId !== reviewId)) {
    throw new AuthoritativeNativeDeliveryStoreError(
      "authoritative delivery intent batch spans multiple reviews"
    );
  }
  const sources = await readVerifiedCiReviewSources(repository, reviewId);
  const variants = await readProjectionVariants(repository, sources, reviewId);
  const deliveries: ResolvedAuthoritativeNativeDelivery[] = [];
  for (const intent of intents) deliveries.push(resolveIntentFromVariants(intent, variants, binding));
  await Promise.all(sources.map((source) =>
    assertVerifiedCiReviewSourceCurrent(repository, source)));
  return deliveries;
}

function resolveIntentFromVariants(intent: DeliveryIntent,
  variants: ReadonlyMap<string, ProjectionVariant>,
  binding: AuthoritativeNativeDeliveryBinding): ResolvedAuthoritativeNativeDelivery {
  const selected = variants.get(intent.envelopeId);
  if (selected === undefined) {
    throw new AuthoritativeNativeDeliveryStoreError(
      "authoritative delivery intent has no exact verified Git CI projection"
    );
  }
  const event = selected.projection.events.find(({ eventId }) => eventId === intent.eventId);
  if (event === undefined || event.reviewId !== intent.reviewId
    || event.envelopeId !== intent.envelopeId) {
    throw new AuthoritativeNativeDeliveryStoreError(
      "authoritative delivery intent does not match its verified event"
    );
  }
  const eventDigest = `sha256:${createHash("sha256").update(binding.eventCodec.serialize(event)).digest("hex")}`;
  if (eventDigest !== intent.eventDigest) {
    throw new AuthoritativeNativeDeliveryStoreError(
      "authoritative delivery intent event digest is invalid"
    );
  }
  return {
    createdAt: selected.projection.createdAt,
    event,
    eventDigest,
    policyDigest: selected.projection.policyDigest,
    provenance: {
      sourceVersions: selected.sources.map(sourceVersion).sort()
    }
  };
}

export async function readVerifiedAuthoritativeNativeDeliveryEvents(
  repository: string,
  binding: AuthoritativeNativeDeliveryBinding,
): Promise<readonly VerifiedAuthoritativeNativeDeliveryEvent[]> {
  const sources = await readVerifiedCiReviewSources(repository);
  const variants = await readProjectionVariants(repository, sources);
  const events = new Map<string, VerifiedAuthoritativeNativeDeliveryEvent>();
  for (const variant of variants.values()) {
    for (const event of variant.projection.events) {
      const eventDigest = `sha256:${createHash("sha256").update(binding.eventCodec.serialize(event)).digest("hex")}`;
      const previous = events.get(event.eventId);
      if (previous !== undefined && previous.eventDigest !== eventDigest) {
        throw new AuthoritativeNativeDeliveryStoreError(
          "verified Git CI projections conflict for a delivery event"
        );
      }
      events.set(event.eventId, {
        createdAt: variant.projection.createdAt,
        event,
        eventDigest,
        policyDigest: variant.projection.policyDigest,
        provenance: { sourceVersions: variant.sources.map(sourceVersion).sort() }
      });
    }
  }
  await Promise.all(sources.map((source) =>
    assertVerifiedCiReviewSourceCurrent(repository, source)));
  return [...events.values()];
}

async function readProjectionVariants(repository: string,
  sources: readonly VerifiedCiReviewSource[], expectedReviewId?: string): Promise<Map<string, ProjectionVariant>> {
  const variants = new Map<string, ProjectionVariant>();
  for (const source of sources) {
    const projection = await readVerifiedGitCiDeliveryProjection(repository, source);
    if (projection === undefined) continue;
    if (expectedReviewId !== undefined && projection.reviewId !== expectedReviewId) {
      throw new AuthoritativeNativeDeliveryStoreError(
        "verified Git CI projection conflicts with its requested review"
      );
    }
    const previous = variants.get(projection.envelopeId);
    if (previous === undefined) {
      variants.set(projection.envelopeId, { projection, sources: [source] });
      continue;
    }
    if (projection.policyDigest !== previous.projection.policyDigest
      || JSON.stringify(projection.events) !== JSON.stringify(previous.projection.events)) {
      throw new AuthoritativeNativeDeliveryStoreError(
        "canonical review variants conflict for the same Git CI projection"
      );
    }
    variants.set(projection.envelopeId, {
      projection: projection.createdAt < previous.projection.createdAt
        ? projection
        : previous.projection,
      sources: [...previous.sources, source]
    });
  }
  return variants;
}

export function sameAuthoritativeNativeDelivery(
  expected: ResolvedAuthoritativeNativeDelivery,
  actual: ResolvedAuthoritativeNativeDelivery
): boolean {
  return expected.createdAt === actual.createdAt
    && expected.eventDigest === actual.eventDigest
    && expected.policyDigest === actual.policyDigest
    && JSON.stringify(expected.event) === JSON.stringify(actual.event)
    && JSON.stringify(expected.provenance) === JSON.stringify(actual.provenance);
}

function sourceVersion(source: VerifiedCiReviewSource): string {
  return `${source.summary.envelopeId}:${source.version}`;
}
