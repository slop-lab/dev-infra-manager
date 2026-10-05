import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseReviewEnvelope, type ReviewEnvelope } from "./review-event-schema.js";
import { publishReviewAcknowledgement } from "./review-acknowledgement-storage.js";
import { readReviewJson } from "./review-record-storage.js";
import type { ReviewPublicationFaults } from "./review-record-storage.js";

const maximumRecordBytes = 128 * 1024 * 1024;
const eventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const reviewDeliveryAcknowledgementSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  eventDigest: digestSchema
}).strict().readonly();

export type ReviewDeliveryAcknowledgement = z.infer<typeof reviewDeliveryAcknowledgementSchema>;

export type ReviewOutboxState = {
  readonly envelopes: readonly ReviewEnvelope[];
  readonly delivered: ReadonlyMap<string, ReviewDeliveryAcknowledgement>;
  readonly pendingCount: number;
  readonly totalCount: number;
};

export type ReviewOutboxStateOptions = {
  readonly proposalRoot: string;
  readonly deliveredRoot: string;
  readonly maximumPending: number;
  readonly maximumDelivered: number;
};

export type ReviewOutboxAcknowledgementOptions = {
  readonly deliveredRoot: string;
  readonly stagingRoot: string;
  readonly entry: { readonly event: ReviewEnvelope["events"][number]; readonly bytes: string };
  readonly storedBytes: string | undefined;
  readonly faults: ReviewPublicationFaults;
};

export async function readReviewEnvelope(path: string): Promise<ReviewEnvelope> {
  return parseReviewEnvelope(await readReviewJson(path, maximumRecordBytes));
}

export async function readReviewOutboxState(options: ReviewOutboxStateOptions): Promise<ReviewOutboxState> {
  const envelopes = await readReviewEnvelopes(options.proposalRoot, options.maximumDelivered);
  const events = new Map(envelopes.flatMap((envelope) => envelope.events.map((event) => [event.eventId, event])));
  const delivered = new Map<string, ReviewDeliveryAcknowledgement>();
  for (const entry of (await readdir(options.deliveredRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const eventId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
    if (!entry.isFile() || !eventIdPattern.test(eventId)) throw new ReviewOutboxStateError("review delivery entry is invalid");
    const acknowledgement = reviewDeliveryAcknowledgementSchema.parse(
      await readReviewJson(join(options.deliveredRoot, entry.name), maximumRecordBytes)
    );
    const event = events.get(eventId);
    if (acknowledgement.eventId !== eventId || event === undefined
      || acknowledgement.eventDigest !== reviewEventDigest(reviewEventBytes(event))) {
      throw new ReviewOutboxStateError("review delivery acknowledgement does not match its event");
    }
    delivered.set(eventId, acknowledgement);
  }
  if (delivered.size > options.maximumDelivered) throw new ReviewOutboxStateError("review delivery markers exceed the storage bound");
  const totalCount = events.size;
  const pendingCount = totalCount - delivered.size;
  if (pendingCount > options.maximumPending) throw new ReviewOutboxStateError("review outbox exceeds the storage bound");
  return { envelopes, delivered, pendingCount, totalCount };
}

export async function readReviewEnvelopes(directory: string, maximumEvents: number): Promise<readonly ReviewEnvelope[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const envelopes: ReviewEnvelope[] = [];
  const eventIds = new Set<string>();
  let eventCount = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw new ReviewOutboxStateError("review store contains an invalid proposal entry");
    }
    const envelope = await readReviewEnvelope(join(directory, entry.name));
    if (`${envelope.review.reviewId}.json` !== entry.name) {
      throw new ReviewOutboxStateError("review proposal path does not match its identity");
    }
    eventCount += envelope.events.length;
    if (eventCount > maximumEvents) throw new ReviewOutboxStateError("review event history exceeds the storage bound");
    for (const event of envelope.events) {
      if (eventIds.has(event.eventId)) throw new ReviewOutboxStateError("review store contains a duplicate event ID");
      eventIds.add(event.eventId);
    }
    envelopes.push(envelope);
  }
  return envelopes;
}

export function reviewEventBytes(event: ReviewEnvelope["events"][number]): string {
  return `${JSON.stringify(event)}\n`;
}

export function reviewEventDigest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

export async function acknowledgeReviewOutboxEvent(
  options: ReviewOutboxAcknowledgementOptions
): Promise<ReviewDeliveryAcknowledgement> {
  if (options.storedBytes === undefined || options.storedBytes !== options.entry.bytes) {
    throw new ReviewOutboxStateError("review delivery acknowledgement event does not match stored bytes");
  }
  const acknowledgement = reviewDeliveryAcknowledgementSchema.parse({
    schemaVersion: 1,
    eventId: options.entry.event.eventId,
    eventDigest: reviewEventDigest(options.entry.bytes)
  });
  const path = join(options.deliveredRoot, `${options.entry.event.eventId}.json`);
  try {
    await publishReviewAcknowledgement({
      path,
      serialized: `${JSON.stringify(acknowledgement)}\n`,
      stagingRoot: options.stagingRoot,
      faults: options.faults
    });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = reviewDeliveryAcknowledgementSchema.parse(await readReviewJson(path, maximumRecordBytes));
    if (existing.eventId !== acknowledgement.eventId || existing.eventDigest !== acknowledgement.eventDigest) {
      throw new ReviewOutboxStateError("review delivery acknowledgement conflicts with stored marker");
    }
  }
  return acknowledgement;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ReviewOutboxStateError extends Error {
  readonly name = "ReviewOutboxStateError";
}
