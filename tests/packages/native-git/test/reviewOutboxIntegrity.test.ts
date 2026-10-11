import { randomUUID } from "node:crypto";
import { chmod, copyFile, link, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNativeGitServiceConfig } from "../../../../core/packages/native-git/src/config.js";
import { parseReviewEnvelope } from "../../../../core/packages/native-git/src/review-event-schema.js";
import { createReviewStore } from "../../../../core/packages/native-git/src/review-store.js";
import {
  reviewDigest,
  reviewObjectSchema,
  type ReviewIdentity,
  type ReviewObject
} from "../../../../core/packages/native-git/src/review-schema.js";
import { refValue } from "./nativeGitHarness.js";
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

describe("DIM native Git review outbox integrity", () => {
  it.each(["missing", "substituted"] as const)("rejects an envelope with a %s required-job event without rewriting it", async (kind) => {
    // Given
    const fixture = await startFixture();
    const response = await createReview(fixture);
    const path = proposalPath(fixture, stringField(response, "reviewId"));
    const envelope = parseReviewEnvelope(JSON.parse(await readFile(path, "utf8")));
    const events = kind === "missing"
      ? envelope.events.slice(1)
      : [{ ...envelope.events[0], jobName: "replacement" }, ...envelope.events.slice(1)];
    const corrupted = `${JSON.stringify({ ...envelope, events })}\n`;
    await writeFile(path, corrupted, "utf8");

    // When / Then
    await expect(fixture.restart()).rejects.toThrow();
    await expect(readFile(path, "utf8")).resolves.toBe(corrupted);
  });

  it("rejects an envelope missing its final required-job event without changing the file or protected ref", async () => {
    // Given
    const fixture = await startFixture();
    const response = await createReview(fixture);
    const path = proposalPath(fixture, stringField(response, "reviewId"));
    const envelope = parseReviewEnvelope(JSON.parse(await readFile(path, "utf8")));
    expect(envelope.events.map((event) => event.jobName)).toEqual(["security", "source"]);
    const corrupted = `${JSON.stringify({ ...envelope, events: envelope.events.slice(0, -1) })}\n`;
    await writeFile(path, corrupted, "utf8");
    const protectedHead = await refValue(fixture.repositoryPath, "refs/heads/main");

    // When / Then
    await expect(fixture.restart()).rejects.toThrow();
    await expect(readFile(path, "utf8")).resolves.toBe(corrupted);
    await expect(refValue(fixture.repositoryPath, "refs/heads/main")).resolves.toBe(protectedHead);
  });

  it("rejects a duplicate event ID across review envelopes without rewriting either review", async () => {
    // Given
    const fixture = await startFixture();
    const firstReview = await persistedReview(fixture);
    const secondReview = anotherReview(firstReview.review, "duplicate-event-id");
    await createReviewStore(fixture.repositoryPath).saveReview(secondReview);
    const secondPath = proposalPath(fixture, secondReview.reviewId);
    const secondEnvelope = parseReviewEnvelope(JSON.parse(await readFile(secondPath, "utf8")));
    const corrupted = `${JSON.stringify({
      ...secondEnvelope,
      events: [
        { ...secondEnvelope.events[0], eventId: firstReview.events[0]?.eventId },
        ...secondEnvelope.events.slice(1)
      ]
    })}\n`;
    await writeFile(secondPath, corrupted, "utf8");
    const firstBytes = await readFile(proposalPath(fixture, firstReview.review.reviewId), "utf8");

    // When / Then
    await expect(fixture.restart()).rejects.toThrow(/event ID/i);
    await expect(readFile(secondPath, "utf8")).resolves.toBe(corrupted);
    await expect(readFile(proposalPath(fixture, firstReview.review.reviewId), "utf8")).resolves.toBe(firstBytes);
  });

  it("rejects an envelope whose review identity predates required-job binding without rewriting it", async () => {
    // Given
    const fixture = await startFixture();
    const response = await createReview(fixture);
    const path = proposalPath(fixture, stringField(response, "reviewId"));
    const envelope = parseReviewEnvelope(JSON.parse(await readFile(path, "utf8")));
    const { requiredJobNames: _requiredJobNames, ...legacyReview } = envelope.review;
    const legacyBytes = `${JSON.stringify({ ...envelope, review: legacyReview })}\n`;
    await writeFile(path, legacyBytes, "utf8");

    // When / Then
    await expect(fixture.restart()).rejects.toThrow();
    await expect(readFile(path, "utf8")).resolves.toBe(legacyBytes);
  });

  it("recovers a same-inode published staging remnant and preserves the immutable envelope", async () => {
    // Given
    const fixture = await startFixture();
    const response = await createReview(fixture);
    const reviewId = stringField(response, "reviewId");
    const finalPath = proposalPath(fixture, reviewId);
    const finalBytes = await readFile(finalPath, "utf8");
    const stagingPath = stagedPath(fixture, reviewId);
    await link(finalPath, stagingPath);
    expect((await stat(stagingPath)).ino).toBe((await stat(finalPath)).ino);

    // When
    await fixture.restart();

    // Then
    await expect(readFile(finalPath, "utf8")).resolves.toBe(finalBytes);
    await expect(stat(stagingPath)).rejects.toThrow();
  });

  it.each(["different-inode", "symbolic-link"] as const)("denies a %s staging remnant without deleting it", async (kind) => {
    // Given
    const fixture = await startFixture();
    const response = await createReview(fixture);
    const reviewId = stringField(response, "reviewId");
    const finalPath = proposalPath(fixture, reviewId);
    const stagingPath = stagedPath(fixture, reviewId);
    if (kind === "different-inode") {
      await copyFile(finalPath, stagingPath);
      await chmod(stagingPath, 0o600);
    } else {
      await symlink(finalPath, stagingPath);
    }
    const stagingIdentity = await stat(stagingPath);

    // When / Then
    await expect(fixture.restart()).rejects.toThrow();
    expect((await stat(stagingPath)).ino).toBe(stagingIdentity.ino);
  });

  it("rejects digit-leading required job names at the native policy boundary", async () => {
    // Given
    const fixture = await startFixture();
    const config = fixture.config;
    const repositories = config.repositories.map((repository) => repository.projectId === "project-a"
      ? {
          ...repository,
          reviewPolicies: repository.reviewPolicies?.map((policy) => ({ ...policy, requiredJobNames: ["1source"] }))
        }
      : repository);
    // When / Then
    expect(() => parseNativeGitServiceConfig({ ...config, repositories })).toThrow();
  });

  it("rejects a digest-mismatched delivery marker without rewriting it", async () => {
    // Given
    const fixture = await startFixture();
    await createReview(fixture);
    const store = createReviewStore(fixture.repositoryPath);
    const event = (await store.readOutbox(1))[0];
    if (event === undefined) throw new Error("expected pending event");
    await store.acknowledgeOutboxEvent(event);
    const marker = join(fixture.repositoryPath, "dim-reviews", "delivered", `${event.event.eventId}.json`);
    const corrupted = `${JSON.stringify({
      schemaVersion: 1,
      eventId: event.event.eventId,
      eventDigest: `sha256:${"0".repeat(64)}`
    })}\n`;
    await writeFile(marker, corrupted, "utf8");

    // When / Then
    await expect(fixture.restart()).rejects.toThrow(/acknowledgement/i);
    await expect(readFile(marker, "utf8")).resolves.toBe(corrupted);
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
  const review = await readJsonObject(response);
  expect(review).not.toHaveProperty("requiredJobNames");
  return review;
}

async function persistedReview(fixture: ReviewFixture) {
  const response = await createReview(fixture);
  return parseReviewEnvelope(JSON.parse(await readFile(proposalPath(fixture, stringField(response, "reviewId")), "utf8")));
}

function anotherReview(review: ReviewObject, suffix: string): ReviewObject {
  const { reviewId: _reviewId, createdAt: _createdAt, ...storedIdentity } = review;
  const identity: ReviewIdentity = { ...storedIdentity, proposalRef: `${review.proposalRef}-${suffix}` };
  return reviewObjectSchema.parse({ ...identity, reviewId: reviewDigest(identity), createdAt: review.createdAt });
}

function proposalPath(fixture: ReviewFixture, reviewId: string): string {
  return join(fixture.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`);
}

function stagedPath(fixture: ReviewFixture, reviewId: string): string {
  return join(fixture.repositoryPath, "dim-reviews", "staging", `${reviewId}.json.${randomUUID()}.tmp`);
}
