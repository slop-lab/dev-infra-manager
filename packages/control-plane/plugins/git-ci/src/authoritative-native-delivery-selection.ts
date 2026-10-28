import { createHash } from "node:crypto";
import {
  assertVerifiedCiReviewSourceCurrent,
  readVerifiedCiReviewSources,
  type VerifiedCiReviewSource
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import {
  readVerifiedGitCiDeliveryProjection,
  type VerifiedGitCiDeliveryProjection
} from "./plan-store.js";
import type { DeliveryIntent } from "./delivery-intent-record.js";
import { AuthoritativeNativeDeliveryStoreError } from "./delivery-marker-storage.js";

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
  readonly event: { readonly eventId: string };
  readonly eventDigest: string;
};

type ProjectionVariant = {
  readonly projection: VerifiedGitCiDeliveryProjection;
  readonly sources: readonly VerifiedCiReviewSource[];
};

export async function resolveAuthoritativeNativeDelivery(
  repository: string,
  intent: DeliveryIntent
): Promise<ResolvedAuthoritativeNativeDelivery> {
  const sources = await readVerifiedCiReviewSources(repository, intent.reviewId);
  const variants = new Map<string, ProjectionVariant>();
  for (const source of sources) {
    const projection = await readVerifiedGitCiDeliveryProjection(repository, source);
    if (projection === undefined) continue;
    if (projection.reviewId !== intent.reviewId) {
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
  const eventDigest = `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
  if (eventDigest !== intent.eventDigest) {
    throw new AuthoritativeNativeDeliveryStoreError(
      "authoritative delivery intent event digest is invalid"
    );
  }
  await Promise.all(selected.sources.map((source) =>
    assertVerifiedCiReviewSourceCurrent(repository, source)));
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
  repository: string
): Promise<readonly VerifiedAuthoritativeNativeDeliveryEvent[]> {
  const sources = await readVerifiedCiReviewSources(repository);
  const events = new Map<string, VerifiedAuthoritativeNativeDeliveryEvent>();
  for (const source of sources) {
    const projection = await readVerifiedGitCiDeliveryProjection(repository, source);
    if (projection === undefined) continue;
    for (const event of projection.events) {
      const eventDigest = `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
      const previous = events.get(event.eventId);
      if (previous !== undefined && previous.eventDigest !== eventDigest) {
        throw new AuthoritativeNativeDeliveryStoreError(
          "verified Git CI projections conflict for a delivery event"
        );
      }
      events.set(event.eventId, { event, eventDigest });
    }
  }
  await Promise.all(sources.map((source) =>
    assertVerifiedCiReviewSourceCurrent(repository, source)));
  return [...events.values()];
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
