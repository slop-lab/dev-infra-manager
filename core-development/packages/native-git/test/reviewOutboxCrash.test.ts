import { chmod, copyFile, lstat, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewEventDigest } from "../../../../core/packages/native-git/src/review-outbox-state.js";
import { createReviewStore } from "../../../../core/packages/native-git/src/review-store.js";
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

describe("DIM native Git review acknowledgement crash consistency", () => {
  it("keeps a marker invisible to a concurrent review scan until atomic publication", async () => {
    // Given
    const fixture = await startFixture();
    await createReview(fixture);
    let releasePublish: (() => void) | undefined;
    const publishReleased = new Promise<void>((resolve) => { releasePublish = resolve; });
    let reachPublish: (() => void) | undefined;
    const publishReached = new Promise<void>((resolve) => { reachPublish = resolve; });
    const store = createReviewStore(fixture.repositoryPath, {
      faults: {
        beforePublish: async () => {
          reachPublish?.();
          await publishReleased;
        }
      }
    });
    const event = (await store.readOutbox(1))[0];
    if (event === undefined) throw new TestSetupError("expected a pending event");

    // When
    const acknowledgement = store.acknowledgeOutboxEvent(event);
    await Promise.race([
      publishReached,
      acknowledgement.then(() => { throw new TestSetupError("acknowledgement did not pause before publication"); })
    ]);

    // Then
    const marker = markerPath(fixture, event.event.eventId);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(createReviewStore(fixture.repositoryPath).readOutbox(2)).resolves.toContainEqual(event);
    const staged = await stagedAcknowledgements(fixture);
    expect(staged).toHaveLength(1);
    expect((await stat(onlyEntry(staged))).mode & 0o777).toBe(0o600);
    releasePublish?.();
    await acknowledgement;
  });

  it.each([
    { phase: "beforeFileSync", published: false },
    { phase: "beforePublish", published: false },
    { phase: "beforeDirectorySync", published: true },
    { phase: "afterPublish", published: true }
  ] as const)("recovers a kill at $phase without a false-delivered marker", async ({ phase, published }) => {
    // Given
    const fixture = await startFixture();
    await createReview(fixture);
    const faults = { [phase]: () => { throw new InjectedCrashError(phase); } };
    const store = createReviewStore(fixture.repositoryPath, { faults });
    const event = (await store.readOutbox(1))[0];
    if (event === undefined) throw new TestSetupError("expected a pending event");

    // When
    await expect(store.acknowledgeOutboxEvent(event)).rejects.toEqual(new InjectedCrashError(phase));

    // Then
    const staged = await stagedAcknowledgements(fixture);
    expect(staged).toHaveLength(1);
    const stagedIdentity = await stat(onlyEntry(staged));
    expect(stagedIdentity.mode & 0o777).toBe(0o600);
    const marker = markerPath(fixture, event.event.eventId);
    if (published) {
      const finalIdentity = await stat(marker);
      expect(finalIdentity.ino).toBe(stagedIdentity.ino);
      expect(finalIdentity.nlink).toBe(2);
      await expect(readFile(marker, "utf8")).resolves.toBe(acknowledgementBytes(event.event.eventId, event.bytes));
    } else {
      expect(stagedIdentity.nlink).toBe(1);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }

    await fixture.restart();

    expect(await stagedAcknowledgements(fixture)).toEqual([]);
    const pending = await createReviewStore(fixture.repositoryPath).readOutbox(2);
    expect(pending.some(({ event: candidate }) => candidate.eventId === event.event.eventId)).toBe(!published);
    if (published) {
      await expect(readFile(marker, "utf8")).resolves.toBe(acknowledgementBytes(event.event.eventId, event.bytes));
    } else {
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves exact EEXIST identity replay while removing the losing staging link", async () => {
    // Given
    const fixture = await startFixture();
    await createReview(fixture);
    const store = createReviewStore(fixture.repositoryPath);
    const event = (await store.readOutbox(1))[0];
    if (event === undefined) throw new TestSetupError("expected a pending event");
    const first = await store.acknowledgeOutboxEvent(event);

    // When
    const replay = await store.acknowledgeOutboxEvent(event);

    // Then
    expect(replay).toEqual(first);
    expect(await stagedAcknowledgements(fixture)).toEqual([]);
    await expect(readFile(markerPath(fixture, event.event.eventId), "utf8"))
      .resolves.toBe(acknowledgementBytes(event.event.eventId, event.bytes));
  });

  it("rejects a digest-conflicting EEXIST marker without replacing either marker or staging state", async () => {
    // Given
    const fixture = await startFixture();
    await createReview(fixture);
    const store = createReviewStore(fixture.repositoryPath);
    const event = (await store.readOutbox(1))[0];
    if (event === undefined) throw new TestSetupError("expected a pending event");
    const marker = markerPath(fixture, event.event.eventId);
    const conflicting = acknowledgementBytes(event.event.eventId, "conflicting event bytes");
    await writeFile(marker, conflicting, { mode: 0o600 });

    // When / Then
    await expect(store.acknowledgeOutboxEvent(event)).rejects.toThrow(/conflicts with stored marker/i);
    await expect(readFile(marker, "utf8")).resolves.toBe(conflicting);
    expect(await stagedAcknowledgements(fixture)).toEqual([]);
  });

  it.each(["foreign-name", "symbolic-link", "wrong-mode"] as const)(
    "rejects and preserves an unsafe %s acknowledgement staging remnant",
    async (kind) => {
      // Given
      const fixture = await startFixture();
      await createReview(fixture);
      const store = createReviewStore(fixture.repositoryPath);
      const event = (await store.readOutbox(1))[0];
      if (event === undefined) throw new TestSetupError("expected a pending event");
      const stagingRoot = join(fixture.repositoryPath, "dim-reviews", "delivery-staging");
      const stagingName = kind === "foreign-name"
        ? "foreign.tmp"
        : `${event.event.eventId}.json.00000000-0000-4000-8000-000000000000.tmp`;
      const stagedPath = join(stagingRoot, stagingName);
      const marker = markerPath(fixture, event.event.eventId);
      if (kind === "symbolic-link") {
        await symlink(marker, stagedPath);
      } else {
        await writeFile(stagedPath, acknowledgementBytes(event.event.eventId, event.bytes), { mode: 0o600 });
        if (kind === "wrong-mode") await chmod(stagedPath, 0o640);
      }
      const stagedIdentity = await lstat(stagedPath);

      // When / Then
      await expect(fixture.restart()).rejects.toThrow(/acknowledgement/i);
      expect((await lstat(stagedPath)).ino).toBe(stagedIdentity.ino);
    }
  );

  it("discards a safe unpublished EEXIST loser while retaining the valid final marker", async () => {
    // Given
    const fixture = await startFixture();
    await createReview(fixture);
    const store = createReviewStore(fixture.repositoryPath);
    const event = (await store.readOutbox(1))[0];
    if (event === undefined) throw new TestSetupError("expected a pending event");
    await store.acknowledgeOutboxEvent(event);
    const marker = markerPath(fixture, event.event.eventId);
    const markerBytes = await readFile(marker, "utf8");
    const stagedPath = join(
      fixture.repositoryPath,
      "dim-reviews",
      "delivery-staging",
      `${event.event.eventId}.json.00000000-0000-4000-8000-000000000000.tmp`
    );
    await copyFile(marker, stagedPath);
    await chmod(stagedPath, 0o600);
    expect((await stat(stagedPath)).ino).not.toBe((await stat(marker)).ino);

    // When
    await fixture.restart();

    // Then
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(marker, "utf8")).resolves.toBe(markerBytes);
    expect((await createReviewStore(fixture.repositoryPath).readOutbox(2))
      .some(({ event: candidate }) => candidate.eventId === event.event.eventId)).toBe(false);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

async function createReview(fixture: ReviewFixture): Promise<void> {
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: fixture.proposalRef
  });
  expect(response.status).toBe(201);
  stringField(await readJsonObject(response), "reviewId");
}

async function stagedAcknowledgements(fixture: ReviewFixture): Promise<readonly string[]> {
  const root = join(fixture.repositoryPath, "dim-reviews", "delivery-staging");
  return (await readdir(root)).map((name) => join(root, name));
}

function markerPath(fixture: ReviewFixture, eventId: string): string {
  return join(fixture.repositoryPath, "dim-reviews", "delivered", `${eventId}.json`);
}

function acknowledgementBytes(eventId: string, eventBytes: string): string {
  return `${JSON.stringify({ schemaVersion: 1, eventId, eventDigest: reviewEventDigest(eventBytes) })}\n`;
}

function onlyEntry(entries: readonly string[]): string {
  const entry = entries[0];
  if (entry === undefined) throw new TestSetupError("expected one staging entry");
  return entry;
}

class InjectedCrashError extends Error {
  readonly name = "InjectedCrashError";
  constructor(readonly phase: string) {
    super(`injected crash at ${phase}`);
  }
}

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
