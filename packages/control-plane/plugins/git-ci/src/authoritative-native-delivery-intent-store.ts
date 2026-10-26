import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ownedReviewDirectory, publishReviewRecord, readReviewJson, recoverPublishedReviewStaging, replaceReviewRecord } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
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

export async function recordExplicitAuthoritativeNativeDeliveryIntent(repository: string,
  envelope: AuthoritativeNativeReviewEnvelope, generationId: string, binding: AuthoritativeNativeDeliveryBinding,
  ownerRequestId: string): Promise<void> {
  const paths = await initializeDeliveryIntentStore(repository);
  for (const event of envelope.events) {
    const eventDigest = `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
    const intent = intentSchema.parse({ schemaVersion: 1, state: "pending", eventId: event.eventId, eventDigest,
      reviewId: envelope.review.reviewId, envelopeId: envelope.envelopeId, generationId, serviceId: binding.serviceId,
      destinationDigest: binding.destinationDigest, ownerRequestId });
    const path = join(paths.intents, `${intentKey(intent)}.json`);
    try { await publishReviewRecord({ path, serialized: `${JSON.stringify(intent)}\n`, stagingRoot: paths.staging, faults: {} }); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const existing = intentSchema.parse(await readReviewJson(path, maximumBytes, true));
      if (!sameIdentity(existing, intent)) throw new DeliveryIntentStoreError("authoritative delivery intent conflicts");
    }
  }
}

export async function readExplicitDeliveryIntents(directory: string, events: readonly Pending[],
  binding: AuthoritativeNativeDeliveryBinding, generationId: string): Promise<ReadonlyMap<string, DeliveryIntent>> {
  const expected = new Map(events.map((delivery) => [delivery.event.eventId, delivery]));
  const intents = new Map<string, DeliveryIntent>();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumEvents) throw new DeliveryIntentStoreError("authoritative delivery intent capacity is exceeded");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) throw new DeliveryIntentStoreError("authoritative delivery intent name is invalid");
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

export async function completeDeliveryIntent(paths: { readonly intents: string; readonly staging: string },
  previous: DeliveryIntent, executionId: string): Promise<void> {
  await replaceIntent(paths, previous, intentSchema.parse({ ...identity(previous), state: "completed", executionId }));
}
export async function supersedeDeliveryIntent(paths: { readonly intents: string; readonly staging: string },
  previous: DeliveryIntent, rejectionStatus: 404 | 409, rejectedAt: number, retryAfter: number): Promise<void> {
  await replaceIntent(paths, previous, intentSchema.parse({ ...identity(previous), state: "superseded", rejectionStatus, rejectedAt, retryAfter }));
}

export async function initializeDeliveryIntentStore(repository: string): Promise<{ readonly intents: string; readonly staging: string }> {
  const root = join(repository, "dim-git-ci-deliveries"), paths = { intents: join(root, "intents"), staging: join(root, "intent-staging") };
  await ownedReviewDirectory(paths.intents); await ownedReviewDirectory(paths.staging);
  await recoverPublishedReviewStaging({ stagingRoot: paths.staging, proposalRoot: paths.intents });
  return paths;
}
async function replaceIntent(paths: { readonly intents: string; readonly staging: string }, previous: DeliveryIntent, next: DeliveryIntent): Promise<void> {
  if (!sameIdentity(previous, next)) throw new DeliveryIntentStoreError("authoritative delivery intent identity changed");
  await replaceReviewRecord({ path: join(paths.intents, `${intentKey(previous)}.json`), serialized: `${JSON.stringify(next)}\n`, stagingRoot: paths.staging, faults: {} });
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
function isCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
export class DeliveryIntentStoreError extends Error { readonly name = "DeliveryIntentStoreError"; }
