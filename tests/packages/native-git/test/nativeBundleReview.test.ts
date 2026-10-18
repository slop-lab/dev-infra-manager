import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  finalizeReadinessToken,
  rootRepository,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";
import {
  addCandidateCommit,
  createBundleReview,
  nativeBundleReviewFixture,
  publishedReviewEnvelopes,
  publishedReviewNames,
  reviewProposalRef,
  reviewWorkspaceId
} from "./nativeBundleReviewFixture.js";
import { seedRootPromotion } from "./nativeCurrentRootProofFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import { createAuthoritativeNativeReviewEnvelope } from "../../../../core/packages/native-git/src/index.js";

afterEach(cleanupFinalizeFixtures);

describe("authoritative installed native review creation", () => {
  it("publishes a new canonical event when a proposal changes its job script", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-changed-script");
    const original = (await publishedReviewEnvelopes(fixture.root))[0];
    if (original === undefined || original.planning.status !== "valid") throw new TypeError("initial envelope is absent");
    const changedScript = "set -euo pipefail\nprintf 'changed source\\n'\n";
    await addCandidateCommit(fixture.clone, ".dim/ci/jobs/source.bash", Buffer.from(changedScript));

    // When
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // Then
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const changed = (await publishedReviewEnvelopes(fixture.root))
      .find(({ review }) => review.candidateCommit === candidate);
    expect(changed?.planning.status).toBe("valid");
    if (changed?.planning.status !== "valid") throw new TypeError("changed envelope planning is invalid");
    const source = changed.planning.jobs.find(({ jobName }) => jobName === "source");
    expect(source?.script.sha256).toBe(`sha256:${createHash("sha256").update(changedScript).digest("hex")}`);
    expect(changed.events.find(({ jobName }) => jobName === "source")?.eventId)
      .not.toBe(original.events.find(({ jobName }) => jobName === "source")?.eventId);
  });

  it("publishes candidate events for newly added ordinary and QEMU jobs", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-added-jobs");
    const runner = `jobs:
  lint:
    script: .dim/ci/jobs/lint.bash
  source:
    script: .dim/ci/jobs/source.bash
  integration:
    script: .dim/ci/jobs/integration.bash
    runtime: qemu
  smoke:
    script: .dim/ci/jobs/smoke.bash
    runtime: qemu
`;
    await writeFile(join(fixture.clone, ".dim/ci/runner.yml"), runner);
    await writeFile(join(fixture.clone, ".dim/ci/jobs/lint.bash"), "set -euo pipefail\nprintf 'lint\\n'\n");
    await writeFile(join(fixture.clone, ".dim/ci/jobs/smoke.bash"), "set -euo pipefail\nprintf 'smoke\\n'\n");
    await runGit("/usr/bin/git", ["-C", fixture.clone, "add", ".dim/ci"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "commit", "-m", "add candidate jobs"]);

    // When
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // Then
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const added = (await publishedReviewEnvelopes(fixture.root))
      .find(({ review }) => review.candidateCommit === candidate);
    expect(added?.events.map(({ executionKind, jobName }) => ({ executionKind, jobName }))).toEqual([
      { executionKind: "ordinary-sysbox", jobName: "lint" },
      { executionKind: "ordinary-sysbox", jobName: "source" },
      { executionKind: "qemu", jobName: "integration" },
      { executionKind: "qemu", jobName: "smoke" }
    ]);
    expect(new Set(added?.events.map(({ eventId }) => eventId)).size).toBe(4);
  });

  it("reconciles exactly once after the service process is killed after ref commit", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-process-crash");
    await closeFinalizeService(fixture.service);
    const childScript = `import { generationId, startFinalizeService, workspaceWriteIssuerAuthorization } from "./packages/native-git/test/nativeRootImportFinalizeFixture.js";
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
const response = await fetch(service.origin + "/v1/projects/project-a/workspace-write-leases", {
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
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], {
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
    const recovered = (await publishedReviewEnvelopes(fixture.root))
      .filter(({ review }) => review.candidateCommit === candidate);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.events.map(({ executionKind, jobName }) => ({ executionKind, jobName }))).toEqual([
      { executionKind: "ordinary-sysbox", jobName: "source" },
      { executionKind: "qemu", jobName: "integration" }
    ]);
    expect(new Set(recovered[0]?.events.map(({ eventId }) => eventId)).size).toBe(2);
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
      .rejects.toThrow();
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "rev-parse", reviewProposalRef]))
      .stdout.trim()).toBe(candidate);
    await Promise.race([
      retryObserved,
      once(AbortSignal.timeout(1_000), "abort").then(() => { throw new Error("proposal retry was not observed"); })
    ]);

    // Then
    let recovered = (await publishedReviewEnvelopes(fixture.root))
      .filter(({ review }) => review.candidateCommit === candidate);
    await vi.waitFor(async () => {
      recovered = (await publishedReviewEnvelopes(fixture.root))
        .filter(({ review }) => review.candidateCommit === candidate);
      expect(recovered).toHaveLength(1);
    });
    expect(recovered).toHaveLength(1);
    expect(new Set(recovered[0]?.events.map(({ eventId }) => eventId)).size).toBe(2);
  });

  it("becomes unready after bounded persistent proposal publication failures", async () => {
    // Given
    let failPublication = false;
    let attempts = 0;
    const fixture = await nativeBundleReviewFixture("bundle-review-persistent-publication-failure", {
      beforeFinalVerification() {
        if (!failPublication) return;
        attempts += 1;
        throw new Error("persistent proposal publication failure");
      }
    });
    failPublication = true;
    await addCandidateCommit(fixture.clone, "persistent-publication-failure.txt", Buffer.from("committed ref\n"));
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();

    // When
    await expect(runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]))
      .rejects.toThrow();

    // Then
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "rev-parse", reviewProposalRef]))
      .stdout.trim()).toBe(candidate);
    await vi.waitFor(async () => {
      const readiness = await fetch(`${fixture.service.origin}/readyz`, {
        headers: { authorization: `Bearer ${finalizeReadinessToken}` }
      });
      expect(readiness.status).toBe(503);
    }, { timeout: 10_000, interval: 100 });
    expect(attempts).toBe(7);
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
  }, 15_000);

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
      .rejects.toThrow();
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
    const recovered = (await publishedReviewEnvelopes(fixture.root))
      .filter(({ review }) => review.candidateCommit === candidate);
    expect(recovered).toHaveLength(1);
    await closeFinalizeService(restarted);
  }, 30_000);
  it("publishes the candidate envelope before a successful proposal push returns", async () => {
    // Given / When
    const fixture = await nativeBundleReviewFixture("bundle-review-automatic");

    // Then
    const names = await publishedReviewNames(fixture.root);
    expect(names).toHaveLength(1);
    const resolved = await createBundleReview(fixture.service);
    expect(names).toEqual([`${resolved.review.reviewId}.${resolved.envelopeId}.json`]);
    expect(resolved.events.map(({ executionKind, jobName }) => ({ executionKind, jobName }))).toEqual([
      { executionKind: "ordinary-sysbox", jobName: "source" },
      { executionKind: "qemu", jobName: "integration" }
    ]);
  });

  it("reconciles a committed proposal ref after restart without another push", async () => {
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
    expect(await publishedReviewNames(fixture.root)).toHaveLength(2);
    await closeFinalizeService(restarted);
  });

  it("withholds proposal push completion until durable envelope publication", async () => {
    // Given
    let blockPublication = false;
    let completed = false;
    let publicationObserved = false;
    const fixture = await nativeBundleReviewFixture("bundle-review-response-order", {
      async beforeFinalVerification() {
        if (!blockPublication) return;
        publicationObserved = true;
        expect(completed).toBe(false);
      }
    });
    blockPublication = true;
    await addCandidateCommit(fixture.clone, "ordered.txt", Buffer.from("ordered\n"));
    const push = runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`])
      .finally(() => { completed = true; });

    // When
    await push;

    // Then
    expect(publicationObserved).toBe(true);
    expect(await publishedReviewNames(fixture.root)).toHaveLength(2);
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
    await publishing;

    // When
    client.kill("SIGKILL");
    await once(client, "close");
    release?.();
    await closeFinalizeService(fixture.service);

    // Then
    expect(await publishedReviewNames(fixture.root)).toHaveLength(2);
  });

  it("publishes candidate events when quality jobs are disabled", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-no-ci", undefined,
      authoritativePolicy(["owner"], [], []));

    // When
    const created = await createBundleReview(fixture.service);

    // Then
    expect(created.requiredJobs).toEqual([]);
    expect(created.events.map(({ jobName }) => jobName)).toEqual(["source", "integration"]);
  });

  it("records a missing manifest as valid empty planning with no events", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-missing-manifest");
    await runGit("/usr/bin/git", ["-C", fixture.clone, "rm", ".dim/ci/runner.yml"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "commit", "-m", "remove candidate jobs"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // When
    const created = await createBundleReview(fixture.service);

    // Then
    expect(created.planning).toEqual({ status: "valid", configBlob: null, jobs: [] });
    expect(created.events).toEqual([]);
  });

  it("durably records invalid planning without partial events", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-invalid-manifest");
    await writeFile(join(fixture.clone, ".dim/ci/runner.yml"), "jobs: invalid\n");
    await runGit("/usr/bin/git", ["-C", fixture.clone, "add", ".dim/ci/runner.yml"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "commit", "-m", "invalid candidate jobs"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // When
    const created = await createBundleReview(fixture.service);

    // Then
    expect(created.planning).toEqual({ status: "invalid", reason: "invalid-candidate-job-plan" });
    expect(created.events).toEqual([]);
    expect(await publishedReviewNames(fixture.root)).toContain(`${created.review.reviewId}.${created.envelopeId}.json`);
  });

  it("keeps the human review identity while quality revision creates a new envelope and events", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-quality-revision");
    const original = await createBundleReview(fixture.service);
    const { reviewId: _reviewId, createdAt, ...identity } = original.review;

    // When
    const revised = createAuthoritativeNativeReviewEnvelope({ identity,
      qualityRevision: "a".repeat(64), policyDigest: "b".repeat(64), requiredJobs: [],
      planning: original.planning, createdAt });

    // Then
    expect(revised.review.reviewId).toBe(original.review.reviewId);
    expect(revised.envelopeId).not.toBe(original.envelopeId);
    expect(revised.events.map(({ eventId }) => eventId)).not.toEqual(original.events.map(({ eventId }) => eventId));
  });

  it("publishes one complete kind-aware review, retries across restart, and rejects malformed storage", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-happy");

    // When
    const created = await createBundleReview(fixture.service);
    const retried = await createBundleReview(fixture.service);
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root);
    await activateFinalizeService(restarted.origin);
    const afterRestart = await createBundleReview(restarted);

    // Then
    expect(retried).toEqual(created);
    expect(afterRestart).toEqual(created);
    expect(created.review.repositoryId).toBe("root");
    expect(created.events.map(({ schemaVersion }) => schemaVersion)).toEqual([3, 3]);
    expect(created.review.patchBytes).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(created.review.patchBytes, "base64").includes(Buffer.from("GIT binary patch"))).toBe(true);
    expect(created.events.map(({ executionKind, jobName, evidenceClass }) => ({
      executionKind,
      jobName,
      evidenceClass
    }))).toEqual([
      { executionKind: "ordinary-sysbox", jobName: "source", evidenceClass: "candidate-controlled" },
      { executionKind: "qemu", jobName: "integration", evidenceClass: "candidate-controlled" }
    ]);
    expect(await publishedReviewNames(fixture.root)).toEqual([`${created.review.reviewId}.${created.envelopeId}.json`]);
    await closeFinalizeService(restarted);
    const record = join(rootRepository(fixture.root), "dim-authoritative-reviews", "proposals",
      `${created.review.reviewId}.${created.envelopeId}.json`);
    const malformed = Buffer.from('{"malformed":true}\n');
    await writeFile(record, malformed, { mode: 0o600 });
    await expect(startFinalizeService(fixture.root)).rejects.toThrow();
    expect(await readFile(record)).toEqual(malformed);
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
    const pushed = runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // When
    release?.();

    // Then
    await expect(creation).resolves.toBeDefined();
    await expect(pushed).resolves.toBeDefined();
    expect(await publishedReviewNames(fixture.root)).toHaveLength(2);
  });

  it("denies a proposal push after an unattested finalized head", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-promoted-head");
    const promoted = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const promotedTree = (await runGit("/usr/bin/git", ["-C", fixture.clone,
      "rev-parse", `${promoted}^{tree}`])).stdout.trim();
    await seedRootPromotion({ root: fixture.root, candidateCommit: promoted, candidateTree: promotedTree });
    await addCandidateCommit(fixture.clone, "next.txt", Buffer.from("next\n"));
    // When
    const pushed = runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin",
      `HEAD:${reviewProposalRef}`]);

    // Then
    await expect(pushed).rejects.toThrow(/409/);
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "rev-parse", reviewProposalRef])).stdout.trim()).toBe(promoted);
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
  });

  it("denies review creation when the current head lacks independent evidence", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-unattested-head");
    const candidateCommit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"]))
      .stdout.trim();
    const candidateTree = (await runGit("/usr/bin/git", ["-C", fixture.clone,
      "rev-parse", `${candidateCommit}^{tree}`])).stdout.trim();
    await seedRootPromotion({ root: fixture.root, candidateCommit, candidateTree });

    // When
    const creation = createBundleReview(fixture.service);

    // Then
    await expect(creation).rejects.toThrow();
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
  });

  it("rejects legacy imported policy and a malformed workspace namespace without publishing", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-denials");
    await closeFinalizeService(fixture.service);
    const policy = {
      protectedRef: "refs/heads/main",
      policyRevision: "policy-1",
      requiredReviewRevision: "reviews-1",
      requiredJobSetRevision: "jobs-1",
      requiredJobNames: ["source"],
      requiredReviewerIds: ["owner"],
      pathReviewerRules: []
    } as const;
    const policyJson = JSON.stringify(policy);
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
    database.prepare("UPDATE native_project_root_import SET policy_json = ?, policy_sha256 = ?")
      .run(policyJson, createHash("sha256").update(policyJson).digest("hex"));
    database.close();
    // When / Then
    await expect(startFinalizeService(fixture.root)).rejects.toThrow(/policy/);
    expect(await publishedReviewNames(fixture.root)).toHaveLength(1);
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
