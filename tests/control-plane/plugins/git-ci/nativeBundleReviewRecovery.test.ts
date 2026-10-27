import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  finalizeReadinessToken,
  rootRepository,
  runGit,
  startFinalizeService
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import {
  addCandidateCommit,
  nativeBundleReviewFixture,
  publishedReviewEnvelopes,
  publishedReviewNames,
  reviewProposalRef,
  reviewWorkspaceId,
  waitForPublishedReview
} from "./nativeBundleReviewFixture.js";
import { readRawProposalJobs } from "../../../../packages/control-plane/plugins/git-review/src/raw-proposal-journal.js";

afterEach(cleanupFinalizeFixtures);

describe("authoritative installed native review creation", () => {
  it("reconciles exactly once after the service process is killed after ref commit", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-process-crash");
    await closeFinalizeService(fixture.service);
    const childScript = `import { generationId, startFinalizeService, workspaceWriteIssuerAuthorization } from ${JSON.stringify(new URL("../git-repositories/nativeRootImportFinalizeFixture.ts", import.meta.url).href)};
const root = process.env.DIM_TEST_ROOT;
const workspaceId = process.env.DIM_TEST_WORKSPACE_ID;
if (root === undefined || workspaceId === undefined) throw new TypeError("missing child fixture input");
let armed = false;
process.on("message", (message) => { if (message?.kind === "arm") armed = true; });
const service = await startFinalizeService(root, undefined, undefined, undefined, undefined, undefined, {
  async beforeFinalVerification() {
    if (!armed) return;
    process.send?.({ kind: "entered" });
    await new Promise(() => {});
  }
});
const response = await fetch(service.origin + "/v1/projects/project-a/repositories/root/workspace-write-leases", {
  method: "POST",
  headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
  body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
});
if (response.status !== 201) throw new TypeError("child workspace lease failed");
const lease = await response.json();
const remote = new URL("/v1/projects/project-a/repositories/root.git", service.origin);
remote.username = lease.username;
remote.password = lease.password;
process.send?.({ kind: "ready", remote: remote.toString() });`;
    const child = spawn(process.execPath, ["--conditions=dim-source", "--import", "tsx", "--input-type=module", "--eval", childScript], {
      cwd: process.cwd(), env: { ...process.env, DIM_TEST_ROOT: fixture.root,
        DIM_TEST_WORKSPACE_ID: reviewWorkspaceId },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let childStderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { childStderr += chunk; });
    const remote = await childMessage(child, "ready", () => childStderr);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "remote", "set-url", "origin", remote]);
    await addCandidateCommit(fixture.clone, "process-crash.txt", Buffer.from("committed before process crash\n"));
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    await sendChildMessage(child, { kind: "arm" });
    const push = spawn("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, stdio: "ignore"
    });
    const pushClosed = once(push, "close");
    await childMessage(child, "entered", () => childStderr);
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "rev-parse", reviewProposalRef]))
      .stdout.trim()).toBe(candidate);
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);

    // When
    child.kill("SIGKILL");
    await once(child, "close");
    await pushClosed;
    const restarted = await startFinalizeService(fixture.root);

    // Then
    const recovered = await waitForPublishedReview(fixture.root, candidate);
    expect(recovered.events.map(({ executionKind, jobName }) => ({ executionKind, jobName }))).toEqual([
      { executionKind: "ordinary-sysbox", jobName: "source" },
      { executionKind: "qemu", jobName: "integration" }
    ]);
    expect(new Set(recovered.events.map(({ eventId }) => eventId)).size).toBe(2);
    await closeFinalizeService(restarted);
  }, 30_000);

  it("retries a committed proposal in-process after one publication failure", async () => {
    // Given
    let failPublication = false;
    let attempts = 0;
    let retried: (() => void) | undefined;
    const retryObserved = new Promise<void>((resolve) => { retried = resolve; });
    const fixture = await nativeBundleReviewFixture("bundle-review-live-retry", {
      beforeFinalVerification() {
        if (!failPublication) return;
        attempts += 1;
        if (attempts === 1) throw new Error("injected envelope publication failure");
        retried?.();
      }
    });
    failPublication = true;
    await addCandidateCommit(fixture.clone, "live-retry.txt", Buffer.from("retry without another push\n"));
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();

    // When
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]))
      .resolves.toBeDefined();
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "rev-parse", reviewProposalRef]))
      .stdout.trim()).toBe(candidate);
    await retryObserved;
    // The retry has entered final verification. Drain that active operation
    // before inspecting publication, rather than racing real Git/fsync work
    // against an unrelated one-second scheduling deadline.
    await closeFinalizeService(fixture.service);

    // Then
    const recovered = (await publishedReviewEnvelopes(fixture.root))
      .filter(({ review }) => review.candidateCommit === candidate);
    expect(recovered).toHaveLength(1);
    expect(new Set(recovered[0]?.events.map(({ eventId }) => eventId)).size).toBe(2);
  });

  it("retains service readiness while bounding and exposing persistent proposal publication failure", async () => {
    // Given
    let failPublication = false;
    let attempts = 0;
    let reachedFinalAttempt: (() => void) | undefined;
    const finalAttempt = new Promise<void>((resolve) => { reachedFinalAttempt = resolve; });
    const fixture = await nativeBundleReviewFixture("bundle-review-persistent-publication-failure", {
      beforeFinalVerification() {
        if (!failPublication) return;
        attempts += 1;
        if (attempts === 6) reachedFinalAttempt?.();
        throw new Error("persistent proposal publication failure");
      }
    });
    failPublication = true;
    await addCandidateCommit(fixture.clone, "persistent-publication-failure.txt", Buffer.from("committed ref\n"));
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();

    // When
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]))
      .resolves.toBeDefined();

    // Then
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "rev-parse", reviewProposalRef]))
      .stdout.trim()).toBe(candidate);
    await finalAttempt;
    await vi.waitFor(async () => {
      expect((await readRawProposalJobs(rootRepository(fixture.root)))
        .find(({ binding }) => binding.candidateCommit === candidate)?.state).toEqual({
          status: "failed", failure: "review-preparation-failed"
        });
      const readiness = await fetch(`${fixture.service.origin}/readyz`, {
        headers: { authorization: `Bearer ${finalizeReadinessToken}` }
      });
      expect(readiness.status).toBe(200);
    }, { timeout: 2_000, interval: 20 });
    expect(attempts).toBe(6);
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
  }, 30_000);

  it("drains an active proposal retry before releasing storage ownership", async () => {
    // Given
    let failPublication = false;
    let attempts = 0;
    let retryEntered: (() => void) | undefined;
    let releaseRetry: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { retryEntered = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const fixture = await nativeBundleReviewFixture("bundle-review-retry-shutdown", {
      async beforeFinalVerification() {
        if (!failPublication) return;
        attempts += 1;
        if (attempts === 1) throw new Error("injected proposal publication failure");
        retryEntered?.();
        await blocked;
      }
    });
    failPublication = true;
    await addCandidateCommit(fixture.clone, "retry-shutdown.txt", Buffer.from("drain retry\n"));
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]))
      .resolves.toBeDefined();
    await entered;
    let closed = false;
    const closing = closeFinalizeService(fixture.service).finally(() => { closed = true; });

    // When
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/active server/);
    expect(closed).toBe(false);
    releaseRetry?.();
    await closing;

    // Then
    const restarted = await startFinalizeService(fixture.root);
    await waitForPublishedReview(fixture.root, candidate);
    await closeFinalizeService(restarted);
  }, 30_000);

  it("does not replay an unjournaled historical proposal ref after restart", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-restart-reconcile");
    await addCandidateCommit(fixture.clone, "crash-window.txt", Buffer.from("committed before envelope\n"));
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    await closeFinalizeService(fixture.service);
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "fetch", fixture.clone, candidate]);
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref", reviewProposalRef, candidate]);

    // When
    const restarted = await startFinalizeService(fixture.root);

    // Then
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
    await closeFinalizeService(restarted);
  });
});

function childMessage(
  child: ChildProcess,
  expectedKind: "ready" | "entered",
  stderr: () => string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || Reflect.get(message, "kind") !== expectedKind) return;
      cleanup();
      const remote = Reflect.get(message, "remote");
      resolve(typeof remote === "string" ? remote : "");
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = (code: number | null) => {
      cleanup();
      reject(new Error(`native Git child exited before ${expectedKind}: ${String(code)}\n${stderr()}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function sendChildMessage(child: ChildProcess, message: { readonly kind: "arm" }): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}
