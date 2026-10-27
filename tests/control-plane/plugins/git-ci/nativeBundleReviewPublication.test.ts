import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    let publicationObserved = false;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await nativeBundleReviewFixture("bundle-review-response-order", {
      async beforeFinalVerification() {
        if (!blockPublication) return;
        publicationObserved = true;
        await blocked;
      }
    });
    blockPublication = true;
    await addCandidateCommit(fixture.clone, "ordered.txt", Buffer.from("ordered\n"));
    const push = runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`])
      .finally(() => { completed = true; });

    // When
    await push;

    // Then
    expect(completed).toBe(true);
    await vi.waitFor(() => { expect(publicationObserved).toBe(true); });
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
    release?.();
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    await waitForPublishedReview(fixture.root, candidate);
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
