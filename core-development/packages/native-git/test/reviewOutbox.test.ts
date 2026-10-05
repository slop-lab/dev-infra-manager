import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewEnvelope } from "../../../../core/packages/native-git/src/review-event-schema.js";
import { createReviewStore, ReviewOutboxFullError } from "../../../../core/packages/native-git/src/review-store.js";
import {
  reviewDigest,
  reviewObjectSchema,
  type ReviewIdentity,
  type ReviewObject
} from "../../../../core/packages/native-git/src/review-schema.js";
import {
  nativeGitReviewFixture,
  readJsonObject,
  reviewPath,
  stringField,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git review outbox", () => {
  it("reuses byte-identical events and IDs across HTTP retries and restart", async () => {
    // Given
    const fixture = await startFixture();
    const first = await createReview(fixture);
    const reviewId = stringField(first, "reviewId");
    const path = proposalPath(fixture, reviewId);
    const originalBytes = await readFile(path, "utf8");
    const store = createReviewStore(fixture.repositoryPath);
    const originalOutbox = await store.readOutbox(2);

    // When
    const retry = await createReview(fixture);
    await fixture.restart();
    const restartedRetry = await createReview(fixture);

    // Then
    expect(stringField(retry, "reviewId")).toBe(reviewId);
    expect(stringField(restartedRetry, "reviewId")).toBe(reviewId);
    await expect(readFile(path, "utf8")).resolves.toBe(originalBytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(createReviewStore(fixture.repositoryPath).readOutbox(2)).resolves.toEqual(originalOutbox);
    expect(originalOutbox.map(({ event }) => event.jobName)).toEqual(["security", "source"]);
    for (const entry of originalOutbox) {
      expect(entry.bytes).toBe(`${JSON.stringify(entry.event)}\n`);
      expect(Object.keys(entry.event)).toEqual([
        "schemaVersion", "type", "eventId", "projectId", "repositoryId", "protectedRef", "reviewId",
        "expectedProtectedHead", "candidateCommit", "candidateTree", "policyRevision", "requiredReviewRevision",
        "requiredJobSetRevision", "jobName", "evidenceClass"
      ]);
      expect(entry.event).not.toHaveProperty("script");
      expect(entry.event).not.toHaveProperty("image");
      expect(entry.event).not.toHaveProperty("credential");
    }
  });

  it.each(["beforeFileSync", "beforePublish"] as const)(
    "leaves no visible review or event when %s fails",
    async (fault) => {
      // Given
      const fixture = await startFixture();
      const stored = await persistedReview(fixture);
      const candidate = anotherReview(stored, fault);
      const store = createReviewStore(fixture.repositoryPath, {
        faults: { [fault]: () => { throw new InjectedPublicationError(); } }
      });

      // When / Then
      await expect(store.saveReview(candidate)).rejects.toBeInstanceOf(InjectedPublicationError);
      await expect(access(proposalPath(fixture, candidate.reviewId))).rejects.toThrow();
      await expect(store.readOutbox(3)).resolves.toHaveLength(2);
    }
  );

  it("rejects a new review before publication when the complete event set exceeds the queue cap", async () => {
    // Given
    const fixture = await startFixture();
    const stored = await persistedReview(fixture);
    const candidate = anotherReview(stored, "queue-cap");
    const store = createReviewStore(fixture.repositoryPath, { maximumUndeliveredEvents: 2 });

    // When / Then
    await expect(store.saveReview(candidate)).rejects.toBeInstanceOf(ReviewOutboxFullError);
    await expect(access(proposalPath(fixture, candidate.reviewId))).rejects.toThrow();
  });

  it("rejects more than 64 required-job events before publication", async () => {
    // Given
    const fixture = await startFixture();
    const stored = await persistedReview(fixture);
    const jobNames = Array.from({ length: 65 }, (_, index) => `job-${index}`);
    const { reviewId: _reviewId, createdAt: _createdAt, ...storedIdentity } = stored;
    const identity: ReviewIdentity = { ...storedIdentity, proposalRef: `${stored.proposalRef}-event-count`, requiredJobNames: jobNames };

    // When / Then
    expect(() => reviewObjectSchema.parse({ ...identity, reviewId: reviewDigest(identity), createdAt: stored.createdAt })).toThrow();
  });

  it("bounds read-only enumeration", async () => {
    // Given
    const fixture = await startFixture();
    await createReview(fixture);
    const store = createReviewStore(fixture.repositoryPath);

    // When / Then
    await expect(store.readOutbox(1)).resolves.toHaveLength(1);
    await expect(store.readOutbox(101)).rejects.toThrow(/enumeration bound/i);
  });

  it.each(["legacy", "foreign-field"] as const)("rejects %s proposal state on restart", async (kind) => {
    // Given
    const fixture = await startFixture();
    const response = await createReview(fixture);
    const path = proposalPath(fixture, stringField(response, "reviewId"));
    const envelope = parseReviewEnvelope(JSON.parse(await readFile(path, "utf8")));
    const malformed = kind === "legacy"
      ? envelope.review
      : { ...envelope, events: [{ ...envelope.events[0], script: ".dim/ci/jobs/unsafe.bash" }, ...envelope.events.slice(1)] };
    await writeFile(path, `${JSON.stringify(malformed)}\n`, "utf8");

    // When / Then
    await expect(fixture.restart()).rejects.toThrow();
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

async function createReview(fixture: ReviewFixture) {
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: fixture.proposalRef
  });
  expect(response.status).toBe(201);
  return readJsonObject(response);
}

async function persistedReview(fixture: ReviewFixture): Promise<ReviewObject> {
  const response = await createReview(fixture);
  const bytes = await readFile(proposalPath(fixture, stringField(response, "reviewId")), "utf8");
  return parseReviewEnvelope(JSON.parse(bytes)).review;
}

function anotherReview(review: ReviewObject, suffix: string): ReviewObject {
  const { reviewId: _reviewId, createdAt: _createdAt, ...storedIdentity } = review;
  const identity: ReviewIdentity = { ...storedIdentity, proposalRef: `${review.proposalRef}-${suffix}` };
  return reviewObjectSchema.parse({ ...identity, reviewId: reviewDigest(identity), createdAt: review.createdAt });
}

function proposalPath(fixture: ReviewFixture, reviewId: string): string {
  return join(fixture.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`);
}

class InjectedPublicationError extends Error {
  readonly name = "InjectedPublicationError";
}
