import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";
import {
  addCandidateCommit,
  createBundleReview,
  nativeBundleReviewFixture,
  publishedReviewNames,
  reviewProposalRef
} from "./nativeBundleReviewFixture.js";
import { seedRootPromotion } from "./nativeCurrentRootProofFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("authoritative installed native review creation", () => {
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
    expect(created.events.map(({ schemaVersion }) => schemaVersion)).toEqual([2, 2]);
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
    expect(await publishedReviewNames(fixture.root)).toEqual([`${created.review.reviewId}.json`]);
    await closeFinalizeService(restarted);
    const record = join(rootRepository(fixture.root), "dim-authoritative-reviews", "proposals",
      `${created.review.reviewId}.json`);
    const malformed = Buffer.from('{"malformed":true}\n');
    await writeFile(record, malformed, { mode: 0o600 });
    await expect(startFinalizeService(fixture.root)).rejects.toThrow();
    expect(await readFile(record)).toEqual(malformed);
  });

  it("rejects a proposal ref that moves during evidence capture without publishing", async () => {
    // Given
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const inspecting = new Promise<void>((resolve) => { entered = resolve; });
    const fixture = await nativeBundleReviewFixture("bundle-review-moving-ref", {
      async beforeFinalVerification() {
        entered?.();
        await blocked;
      }
    });
    const creation = createBundleReview(fixture.service);
    await inspecting;
    await addCandidateCommit(fixture.clone, "moved.txt", Buffer.from("moved\n"));
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);

    // When
    release?.();

    // Then
    await expect(creation).rejects.toThrow(/changed during review creation/);
    expect(await publishedReviewNames(fixture.root)).toEqual([]);
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
    expect(await publishedReviewNames(fixture.root)).toEqual([]);
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
    expect(await publishedReviewNames(fixture.root)).toEqual([]);
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
    const restarted = await startFinalizeService(fixture.root);
    await activateFinalizeService(restarted.origin);

    // When / Then
    await expect(createBundleReview(restarted)).rejects.toThrow(/legacy imported-root policy/);
    await expect(restarted.createReview({
      projectId: "project-a",
      repositoryId: "root",
      proposalRef: "refs/heads/proposals/not-a-workspace/change"
    })).rejects.toThrow(/selector is invalid/);
    expect(await publishedReviewNames(fixture.root)).toEqual([]);
  });
});
