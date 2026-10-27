import { afterEach, expect, it, vi } from "vitest";
import * as repositoryApi from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { addCandidateCommit, nativeBundleReviewFixture, reviewProposalRef } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, rootRepository, runGit } from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { readRawProposalJobs } from "../../../../packages/control-plane/plugins/git-review/src/raw-proposal-journal.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanupFinalizeFixtures(); });

it("retries unavailable target proof without recording an unobserved authority change as terminal stale", async () => {
  // Given an operational proof failure, not a successfully observed authority mismatch.
  const fixture = await nativeBundleReviewFixture("raw-transient-proof");
  const resolve = repositoryApi.resolveAuthoritativeNativeRepositoryTarget;
  let attempts = 0;
  vi.spyOn(repositoryApi, "resolveAuthoritativeNativeRepositoryTarget").mockImplementation(async (runtime, selector) => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient proof unavailable");
    return resolve(runtime, selector);
  });
  await addCandidateCommit(fixture.clone, "retry-proof.txt", Buffer.from("retry operational failure\n"));
  const candidateCommit = (await runGit("/usr/bin/git", ["-C", fixture.clone, "rev-parse", "HEAD"])).stdout.trim();
  // When the real push hands off the exact candidate.
  await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  // Then bounded recovery can still prepare that same candidate.
  await expect.poll(async () => (await readRawProposalJobs(rootRepository(fixture.root)))
    .find(({ binding }) => binding.candidateCommit === candidateCommit)?.state.status, { timeout: 10_000 }).toBe("ready");
  expect(attempts).toBeGreaterThan(1);
});
