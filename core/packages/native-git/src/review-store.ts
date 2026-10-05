import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createReviewEnvelope,
  parseReviewEnvelope,
  type NativeReviewJobEvent,
  type ReviewEnvelope
} from "./review-event-schema.js";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  recoverPublishedReviewStaging,
  writeImmutableReviewRecord,
  type ReviewPublicationFaults
} from "./review-record-storage.js";
import {
  reviewApprovalSchema,
  reviewRevocationSchema,
  type ReviewApproval,
  type ReviewObject,
  type ReviewRevocation
} from "./review-schema.js";

const filePattern = /^[0-9a-f-]+\.json$/;
const MAX_RECORD_BYTES = 128 * 1024 * 1024;
const MAX_UNDELIVERED_EVENTS = 10_000;
const MAX_OUTBOX_ENUMERATION = 100;

export type ReviewOutboxEntry = {
  readonly event: NativeReviewJobEvent;
  readonly bytes: string;
};

export type ReviewOutboxSelector = {
  readonly reviewId: string;
  readonly eventId: string;
  readonly jobName: string;
};

export type ReviewStoreOptions = {
  readonly faults?: ReviewPublicationFaults;
  readonly maximumUndeliveredEvents?: number;
};

export type ReviewStore = {
  saveReview(review: ReviewObject): Promise<ReviewObject>;
  readReview(reviewId: string): Promise<ReviewObject | undefined>;
  readOutboxEvent(selector: ReviewOutboxSelector): Promise<ReviewOutboxEntry | undefined>;
  readOutbox(maximumEntries: number): Promise<readonly ReviewOutboxEntry[]>;
  saveApproval(input: Omit<ReviewApproval, "approvalId" | "approvedAt" | "schemaVersion">): Promise<ReviewApproval>;
  readApprovals(reviewId: string): Promise<readonly ReviewApproval[]>;
  saveRevocation(input: Omit<ReviewRevocation, "revokedAt" | "schemaVersion">): Promise<ReviewRevocation>;
  readRevocations(reviewId: string): Promise<readonly ReviewRevocation[]>;
};

export async function initializeReviewStore(repositoryPath: string): Promise<void> {
  const root = join(repositoryPath, "dim-reviews");
  await ownedReviewDirectory(root);
  await Promise.all(["proposals", "staging", "approvals", "revocations"]
    .map((name) => ownedReviewDirectory(join(root, name))));
}

export async function assertReviewStore(repositoryPath: string): Promise<void> {
  const root = join(repositoryPath, "dim-reviews");
  for (const name of ["", "proposals", "staging", "approvals", "revocations"]) {
    await assertOwnedReviewDirectory(name.length === 0 ? root : join(root, name));
  }
  const proposalRoot = join(root, "proposals");
  await recoverPublishedReviewStaging({ stagingRoot: join(root, "staging"), proposalRoot });
  await readEnvelopes(proposalRoot, MAX_UNDELIVERED_EVENTS);
  for (const category of ["approvals", "revocations"] as const) {
    const categoryRoot = join(root, category);
    for (const entry of await readdir(categoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) throw new ReviewStoreError("review store contains an invalid event directory");
      await assertOwnedReviewDirectory(join(categoryRoot, entry.name));
      for (const file of await readdir(join(categoryRoot, entry.name), { withFileTypes: true })) {
        if (!file.isFile() || !filePattern.test(file.name)) throw new ReviewStoreError("review store contains an invalid event entry");
        const value = await readReviewJson(join(categoryRoot, entry.name, file.name), MAX_RECORD_BYTES);
        if (category === "approvals") {
          const approval = reviewApprovalSchema.parse(value);
          if (approval.reviewId !== entry.name || `${approval.approvalId}.json` !== file.name) {
            throw new ReviewStoreError("review approval path does not match its identity");
          }
        } else {
          const revocation = reviewRevocationSchema.parse(value);
          if (revocation.reviewId !== entry.name || `${revocation.approvalId}.json` !== file.name) {
            throw new ReviewStoreError("review revocation path does not match its identity");
          }
        }
      }
    }
  }
}

export function createReviewStore(repositoryPath: string, options: ReviewStoreOptions = {}): ReviewStore {
  const root = join(repositoryPath, "dim-reviews");
  const proposalRoot = join(root, "proposals");
  const maximumUndeliveredEvents = options.maximumUndeliveredEvents ?? MAX_UNDELIVERED_EVENTS;
  return {
    async saveReview(review) {
      const path = join(proposalRoot, `${review.reviewId}.json`);
      let existing: ReviewObject | undefined;
      try {
        existing = (await readEnvelope(path)).review;
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      const existingEnvelopes = await readEnvelopes(proposalRoot, maximumUndeliveredEvents);
      if (existing !== undefined) return existing;
      const envelope = createReviewEnvelope(review);
      const currentCount = existingEnvelopes
        .reduce((total, current) => total + current.events.length, 0);
      if (currentCount + envelope.events.length > maximumUndeliveredEvents) throw new ReviewOutboxFullError();
      const existingEventIds = new Set(existingEnvelopes.flatMap((current) => current.events.map((event) => event.eventId)));
      if (envelope.events.some((event) => existingEventIds.has(event.eventId))) {
        throw new ReviewStoreError("review event ID collides with an existing event");
      }
      const serialized = `${JSON.stringify(envelope)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
        throw new ReviewStoreError("review record exceeds the storage bound");
      }
      try {
        await publishReviewRecord({
          path,
          serialized,
          stagingRoot: join(root, "staging"),
          faults: options.faults ?? {}
        });
        return review;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        return (await readEnvelope(path)).review;
      }
    },
    async readReview(reviewId) {
      const path = join(root, "proposals", `${reviewId}.json`);
      try {
        return (await readEnvelope(path)).review;
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async readOutboxEvent(selector) {
      let envelope: ReviewEnvelope;
      try {
        envelope = await readEnvelope(join(proposalRoot, `${selector.reviewId}.json`));
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
      const event = envelope.events.find((candidate) => candidate.eventId === selector.eventId
        && candidate.reviewId === selector.reviewId && candidate.jobName === selector.jobName);
      return event === undefined ? undefined : { event, bytes: `${JSON.stringify(event)}\n` };
    },
    async readOutbox(maximumEntries) {
      if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > MAX_OUTBOX_ENUMERATION) {
        throw new ReviewStoreError("review outbox enumeration bound is invalid");
      }
      const envelopes = await readEnvelopes(proposalRoot, maximumUndeliveredEvents);
      return envelopes
        .flatMap((envelope) => envelope.events.map((event) => ({ createdAt: envelope.review.createdAt, event })))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.event.jobName.localeCompare(right.event.jobName)
          || left.event.eventId.localeCompare(right.event.eventId))
        .slice(0, maximumEntries)
        .map(({ event }) => ({ event, bytes: `${JSON.stringify(event)}\n` }));
    },
    async saveApproval(input) {
      const approval = reviewApprovalSchema.parse({
        ...input,
        schemaVersion: 1,
        approvalId: randomUUID(),
        approvedAt: new Date().toISOString()
      });
      const directory = join(root, "approvals", approval.reviewId);
      await ownedReviewDirectory(directory);
      await writeImmutableReviewRecord(join(directory, `${approval.approvalId}.json`), approval);
      return approval;
    },
    async readApprovals(reviewId) {
      return readEvents(join(root, "approvals", reviewId), reviewApprovalSchema.parse);
    },
    async saveRevocation(input) {
      const revocation = reviewRevocationSchema.parse({ ...input, schemaVersion: 1, revokedAt: new Date().toISOString() });
      const directory = join(root, "revocations", revocation.reviewId);
      await ownedReviewDirectory(directory);
      const path = join(directory, `${revocation.approvalId}.json`);
      try {
        await writeImmutableReviewRecord(path, revocation);
        return revocation;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        return reviewRevocationSchema.parse(await readReviewJson(path, MAX_RECORD_BYTES));
      }
    },
    async readRevocations(reviewId) {
      return readEvents(join(root, "revocations", reviewId), reviewRevocationSchema.parse);
    }
  };
}

async function readEvents<T>(directory: string, parse: (input: unknown) => T): Promise<readonly T[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const values: T[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !filePattern.test(entry.name)) throw new ReviewStoreError("review event entry is invalid");
    values.push(parse(await readReviewJson(join(directory, entry.name), MAX_RECORD_BYTES)));
  }
  return values;
}

async function readEnvelope(path: string): Promise<ReviewEnvelope> {
  return parseReviewEnvelope(await readReviewJson(path, MAX_RECORD_BYTES));
}

async function readEnvelopes(directory: string, maximumEvents: number): Promise<readonly ReviewEnvelope[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const envelopes: ReviewEnvelope[] = [];
  const eventIds = new Set<string>();
  let eventCount = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw new ReviewStoreError("review store contains an invalid proposal entry");
    }
    const envelope = await readEnvelope(join(directory, entry.name));
    if (`${envelope.review.reviewId}.json` !== entry.name) throw new ReviewStoreError("review proposal path does not match its identity");
    eventCount += envelope.events.length;
    if (eventCount > maximumEvents) throw new ReviewStoreError("review outbox exceeds the storage bound");
    for (const event of envelope.events) {
      if (eventIds.has(event.eventId)) throw new ReviewStoreError("review store contains a duplicate event ID");
      eventIds.add(event.eventId);
    }
    envelopes.push(envelope);
  }
  return envelopes;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ReviewStoreError extends Error {
  readonly name: string = "ReviewStoreError";
}

export class ReviewOutboxFullError extends ReviewStoreError {
  readonly name = "ReviewOutboxFullError";
  constructor() {
    super("review outbox is full");
  }
}
