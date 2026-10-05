import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createReviewEnvelope,
  parseReviewEnvelope,
  type NativeReviewJobEvent,
  type ReviewEnvelope
} from "./review-event-schema.js";
import {
  ownedReviewDirectory,
  publishReviewRecord,
  readReviewJson,
  writeImmutableReviewRecord,
  type ReviewPublicationFaults
} from "./review-record-storage.js";
import {
  acknowledgeReviewOutboxEvent,
  readReviewEnvelope,
  readReviewOutboxState,
  reviewEventBytes,
  type ReviewDeliveryAcknowledgement
} from "./review-outbox-state.js";
import { readReviewEvidenceRecords } from "./review-evidence-records.js";
import { ReviewOutboxFullError, ReviewStoreError } from "./review-store-errors.js";
import {
  reviewApprovalSchema,
  reviewRevocationSchema,
  type ReviewApproval,
  type ReviewObject,
  type ReviewRevocation
} from "./review-schema.js";

const MAX_RECORD_BYTES = 128 * 1024 * 1024;
const MAX_UNDELIVERED_EVENTS = 10_000;
const MAX_DELIVERED_EVENTS = 100_000;
const MAX_OUTBOX_ENUMERATION = 100;

export type ReviewOutboxEntry = {
  readonly event: NativeReviewJobEvent;
  readonly bytes: string;
  readonly createdAt: string;
};

export type ReviewOutboxSelector = {
  readonly reviewId: string;
  readonly eventId: string;
  readonly jobName: string;
};

export type ReviewStoreOptions = {
  readonly faults?: ReviewPublicationFaults;
  readonly maximumUndeliveredEvents?: number;
  readonly maximumDeliveredEvents?: number;
};

export type ReviewStore = {
  saveReview(review: ReviewObject): Promise<ReviewObject>;
  readReview(reviewId: string): Promise<ReviewObject | undefined>;
  readOutboxEvent(selector: ReviewOutboxSelector): Promise<ReviewOutboxEntry | undefined>;
  readOutbox(maximumEntries: number): Promise<readonly ReviewOutboxEntry[]>;
  acknowledgeOutboxEvent(entry: ReviewOutboxEntry): Promise<ReviewDeliveryAcknowledgement>;
  saveApproval(input: Omit<ReviewApproval, "approvalId" | "approvedAt" | "schemaVersion">): Promise<ReviewApproval>;
  readApprovals(reviewId: string): Promise<readonly ReviewApproval[]>;
  saveRevocation(input: Omit<ReviewRevocation, "revokedAt" | "schemaVersion">): Promise<ReviewRevocation>;
  readRevocations(reviewId: string): Promise<readonly ReviewRevocation[]>;
};

export { assertReviewStore, initializeReviewStore } from "./review-store-lifecycle.js";
export { ReviewOutboxFullError, ReviewStoreError } from "./review-store-errors.js";

export function createReviewStore(repositoryPath: string, options: ReviewStoreOptions = {}): ReviewStore {
  const root = join(repositoryPath, "dim-reviews");
  const proposalRoot = join(root, "proposals");
  const deliveredRoot = join(root, "delivered");
  const deliveryStagingRoot = join(root, "delivery-staging");
  const maximumUndeliveredEvents = options.maximumUndeliveredEvents ?? MAX_UNDELIVERED_EVENTS;
  const maximumDeliveredEvents = options.maximumDeliveredEvents ?? MAX_DELIVERED_EVENTS;
  return {
    async saveReview(review) {
      const path = join(proposalRoot, `${review.reviewId}.json`);
      let existing: ReviewObject | undefined;
      try {
        existing = (await readReviewEnvelope(path)).review;
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      const state = await readReviewOutboxState({
        proposalRoot,
        deliveredRoot,
        maximumPending: maximumUndeliveredEvents,
        maximumDelivered: maximumDeliveredEvents
      });
      if (existing !== undefined) return existing;
      const envelope = createReviewEnvelope(review);
      if (state.pendingCount + envelope.events.length > maximumUndeliveredEvents
        || state.totalCount + envelope.events.length > maximumDeliveredEvents) throw new ReviewOutboxFullError();
      const existingEventIds = new Set(state.envelopes.flatMap((current) => current.events.map((event) => event.eventId)));
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
        return (await readReviewEnvelope(path)).review;
      }
    },
    async readReview(reviewId) {
      const path = join(root, "proposals", `${reviewId}.json`);
      try {
        return (await readReviewEnvelope(path)).review;
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async readOutboxEvent(selector) {
      let envelope: ReviewEnvelope;
      try {
        envelope = await readReviewEnvelope(join(proposalRoot, `${selector.reviewId}.json`));
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
      const event = envelope.events.find((candidate) => candidate.eventId === selector.eventId
        && candidate.reviewId === selector.reviewId && candidate.jobName === selector.jobName);
      return event === undefined ? undefined : { event, bytes: reviewEventBytes(event), createdAt: envelope.review.createdAt };
    },
    async readOutbox(maximumEntries) {
      if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > MAX_OUTBOX_ENUMERATION) {
        throw new ReviewStoreError("review outbox enumeration bound is invalid");
      }
      const state = await readReviewOutboxState({
        proposalRoot,
        deliveredRoot,
        maximumPending: maximumUndeliveredEvents,
        maximumDelivered: maximumDeliveredEvents
      });
      return state.envelopes
        .flatMap((envelope) => envelope.events.map((event) => ({ createdAt: envelope.review.createdAt, event })))
        .filter(({ event }) => !state.delivered.has(event.eventId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.event.jobName.localeCompare(right.event.jobName)
          || left.event.eventId.localeCompare(right.event.eventId))
        .slice(0, maximumEntries)
        .map(({ event, createdAt }) => ({ event, bytes: reviewEventBytes(event), createdAt }));
    },
    async acknowledgeOutboxEvent(entry) {
      const stored = await this.readOutboxEvent({
        reviewId: entry.event.reviewId,
        eventId: entry.event.eventId,
        jobName: entry.event.jobName
      });
      return acknowledgeReviewOutboxEvent({
        deliveredRoot,
        stagingRoot: deliveryStagingRoot,
        entry,
        storedBytes: stored?.bytes,
        faults: options.faults ?? {}
      });
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
      return readReviewEvidenceRecords(join(root, "approvals", reviewId), reviewApprovalSchema.parse);
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
      return readReviewEvidenceRecords(join(root, "revocations", reviewId), reviewRevocationSchema.parse);
    }
  };
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
