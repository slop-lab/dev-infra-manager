import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { isCandidateAbsorbed, reconcileNativeProposalRefs, reconcileRegisteredNativeProposals } from "../../../../packages/control-plane/plugins/git-review/src/native-proposal-reconciler.js";
import {
  readNativeProposalRefs
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-proposal-reconciler.js";
import { candidateContext } from "./authoritativeNativeCandidateFixture.js";
import {
  cleanupFinalizeFixtures,
  closeFinalizeService,
  rootRepository,
  runGit
} from "./nativeRootImportFinalizeFixture.js";
import {
  nativeBundleReviewFixture,
  reviewProposalRef,
  reviewWorkspaceId
} from "../git-ci/nativeBundleReviewFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native proposal ref reconciliation bounds", () => {
  it("skips absorbed proposal refs during startup while retaining fresh reconciliation and explicit retry", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("reconciliation-absorbed-startup");
    const repository = rootRepository(fixture.root);
    const protectedCommit = (await runGit("/usr/bin/git", ["--git-dir", repository, "rev-parse", "refs/heads/main"])).stdout.trim();
    const strictDescendant = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    expect(strictDescendant).not.toBe(protectedCommit);
    await expect(isCandidateAbsorbed({ runtime: fixture.service.context.runtime, repository,
      candidateCommit: protectedCommit, protectedCommit: strictDescendant })).resolves.toBe(true);
    const absorbedRef = `refs/heads/proposals/${reviewWorkspaceId}/absorbed`;
    await runGitInput(repository, `update ${absorbedRef} ${protectedCommit}\n`);

    // When
    const startup = await fixture.service.context.serialize(() => reconcileRegisteredNativeProposals(fixture.service.context.runtime));

    // Then
    expect(startup.some(({ review }) => review.proposalRef === absorbedRef)).toBe(false);
    expect(startup.some(({ review }) => review.proposalRef === reviewProposalRef)).toBe(true);
    const retry = await fixture.service.context.serialize(() => reconcileNativeProposalRefs(
      fixture.service.context.runtime, "project-a", "root", [reviewProposalRef]
    ));
    expect(retry).toHaveLength(1);
    expect(retry[0]?.review.proposalRef).toBe(reviewProposalRef);
  });

  it("rejects more than ten thousand proposal refs", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("proposal-ref-count-bound");
    await closeFinalizeService(fixture.service);
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const repository = rootRepository(fixture.root);
    const updates = Array.from({ length: 10_001 }, (_, index) =>
      `update refs/heads/proposals/${reviewWorkspaceId}/count-${index} ${candidate}\n`).join("");
    await runGitInput(repository, updates);
    const opened = await candidateContext(fixture.root);

    // When / Then
    await expect(readNativeProposalRefs(opened.context, "project-a", "root"))
      .rejects.toThrow("native proposal ref capacity is exceeded");
    await opened.close();
  }, 60_000);

  it("rejects proposal enumeration output larger than four MiB", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("proposal-ref-output-bound");
    await closeFinalizeService(fixture.service);
    const candidate = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
    const repository = rootRepository(fixture.root);
    const suffix = Array.from({ length: 5 }, () => "x".repeat(180)).join("/");
    const updates = Array.from({ length: 5_000 }, (_, index) =>
      `update refs/heads/proposals/${reviewWorkspaceId}/output-${index}-${suffix} ${candidate}\n`).join("");
    await runGitInput(repository, updates);
    const opened = await candidateContext(fixture.root);

    // When / Then
    await expect(readNativeProposalRefs(opened.context, "project-a", "root"))
      .rejects.toThrow(/stdout maxBuffer length exceeded/);
    await opened.close();
  }, 60_000);
});

function runGitInput(repository: string, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", ["--git-dir", repository, "update-ref", "--stdin"], {
      env: { ...process.env, LC_ALL: "C" }, stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git update-ref failed (${String(code)}): ${stderr}`));
    });
    child.stdin.end(input);
  });
}
