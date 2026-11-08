import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  runGit
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import {
  addCandidateCommit,
  createBundleReview,
  nativeBundleReviewFixture,
  publishedReviewNames,
  reviewProposalRef,
  waitForPublishedReview
} from "./nativeBundleReviewFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("authoritative installed native review creation", () => {
  it("returns proposal push after raw handoff before durable envelope publication", async () => {
    // Given
    let blockPublication = false;
    let completed = false;
    const observationAllowed = Promise.withResolvers<void>();
    const publicationEntered = Promise.withResolvers<void>();
    const publicationReleased = Promise.withResolvers<void>();
    const fixture = await nativeBundleReviewFixture("bundle-review-response-order", {
      async beforeFinalVerification() {
        if (!blockPublication) return;
        // Hook observation may arrive after the Git response, with no 1s product contract.
        await observationAllowed.promise;
        publicationEntered.resolve();
        await publicationReleased.promise;
      }
    });
    blockPublication = true;
    await addCandidateCommit(fixture.clone, "ordered.txt", Buffer.from("ordered\n"));
    const push = runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`])
      .finally(() => { completed = true; });

    try {
      // When: the real Git client must finish while publication is still blocked.
      await phase("proposal push before publication release", push);

      // Then: observe the actual hook explicitly, never by short polling.
      expect(completed).toBe(true);
      observationAllowed.resolve();
      await phase("durable publication hook entry", publicationEntered.promise);
      expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
      publicationReleased.resolve();
      const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
      await waitForPublishedReview(fixture.root, candidate);
    } finally {
      // Assertion failure must not strand the raw worker inside its publication hook.
      observationAllowed.resolve(); publicationReleased.resolve();
      try { await phase("proposal client settlement during cleanup", push.then(() => {}, () => {})); }
      finally { await phase("publication worker drain during cleanup", closeFinalizeService(fixture.service)); }
    }
  });

  it("persists the committed proposal after the pushing client disconnects", async () => {
    // Given
    let blockPublication = false;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const publishing = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await nativeBundleReviewFixture("bundle-review-client-disconnect", {
      async beforeFinalVerification() {
        if (!blockPublication) return;
        entered?.();
        await blocked;
      }
    });
    blockPublication = true;
    await addCandidateCommit(fixture.clone, "disconnect.txt", Buffer.from("disconnect\n"));
    const client = spawn("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, stdio: "ignore"
    });
    await once(client, "close");
    await publishing;

    // When
    release?.();
    await closeFinalizeService(fixture.service);

    // Then
    expect(await publishedReviewNames(fixture.root)).toHaveLength(2);
  });

  it("serializes a proposal ref move behind in-progress evidence capture", async () => {
    // Given
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const inspecting = new Promise<void>((resolve) => { entered = resolve; });
    let blockPublication = false;
    const fixture = await nativeBundleReviewFixture("bundle-review-moving-ref", {
      async beforeFinalVerification() {
        if (!blockPublication) return;
        entered?.();
        await blocked;
      }
    });
    blockPublication = true;
    const creation = createBundleReview(fixture.service);
    await inspecting;
    await addCandidateCommit(fixture.clone, "moved.txt", Buffer.from("moved\n"));
    const moved = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const pushed = runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // When
    release?.();

    // Then
    await expect(creation).resolves.toBeDefined();
    await expect(pushed).resolves.toBeDefined();
    await waitForPublishedReview(fixture.root, moved);
    expect(await publishedReviewNames(fixture.root)).toHaveLength(2);
  });
});

/** Named fixture phase within the existing test budget, with no product deadline change. */
async function phase<T>(name: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`native publication fixture phase exceeded 5s: ${name}`)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
