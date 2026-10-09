import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateExecutionError, candidateArgv, descriptorDigest } from "../../../../core/packages/native-git/src/index.js";
import {
  authoritativePolicy,
  digest,
  matchingRunner,
  wrongKindRunner
} from "./authoritativeNativeCandidateFixture.js";
import {
  createBundleReview,
  nativeBundleReviewFixture,
  reviewProposalRef
} from "./nativeBundleReviewFixture.js";
import {
  cleanupFinalizeFixtures,
  rootRepository,
  runGit
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

const trustedCapacity = {
  admissionGeneration: "generation-7",
  jobBaseImage: `registry.example/job@sha256:${"a".repeat(64)}`,
  runnerBaseImage: `registry.example/runner@sha256:${"b".repeat(64)}`,
  bounds: {
    cpu: "2",
    memoryBytes: "2147483648",
    pids: "512",
    wallClockSeconds: "900",
    outputBytes: "10485760"
  }
} as const;

describe("authoritative ordinary execution descriptor", () => {
  it("derives exact ordinary provenance from the current immutable review without mutation", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("ordinary-descriptor");
    const envelope = await createBundleReview(fixture.service);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const result = await fixture.service.deriveOrdinaryExecutionDescriptor({
      projectId: "project-a",
      reviewId: envelope.review.reviewId,
      jobName: "source",
      trustedCapacity
    });

    // Then
    const repository = rootRepository(fixture.root);
    const configObjectId = await gitObjectId(repository, envelope.review.candidateTree, ".dim/ci/runner.yml");
    const scriptObjectId = await gitObjectId(repository, envelope.review.candidateTree, ".dim/ci/jobs/source.bash");
    expect(result).toEqual({
      kind: "ordinary-sysbox",
      reviewId: envelope.review.reviewId,
      descriptor: {
        admissionGeneration: trustedCapacity.admissionGeneration,
        jobName: "source",
        runnerBaseImage: trustedCapacity.runnerBaseImage,
        bounds: trustedCapacity.bounds,
        projectId: "project-a",
        repositoryId: "root",
        protectedRef: envelope.review.protectedRef,
        expectedProtectedHead: envelope.review.expectedProtectedHead,
        candidateCommit: envelope.review.candidateCommit,
        candidateTree: envelope.review.candidateTree,
        policyRevision: envelope.review.policyRevision,
        requiredReviewRevision: envelope.review.requiredReviewRevision,
        requiredJobSetRevision: envelope.review.requiredJobSetRevision,
        evidenceClass: "candidate-controlled",
        configBlob: { objectId: configObjectId, sha256: digest(matchingRunner()) },
        script: {
          path: ".dim/ci/jobs/source.bash",
          objectId: scriptObjectId,
          sha256: digest("set -euo pipefail\nprintf 'source\\n'\n")
        },
        argv: candidateArgv,
        jobImage: trustedCapacity.jobBaseImage
      },
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    expect(result.digest).toBe(descriptorDigest(result.descriptor));
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });

  it("rejects QEMU selection through the explicit ordinary-only API", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("ordinary-qemu-rejection");
    const envelope = await createBundleReview(fixture.service);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const derive = fixture.service.deriveOrdinaryExecutionDescriptor({
      projectId: "project-a", reviewId: envelope.review.reviewId, jobName: "integration", trustedCapacity
    });

    // Then
    await expect(derive).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });

  it("rejects a candidate that moves a policy-bound QEMU job to ordinary", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("ordinary-wrong-kind");
    await writeFile(join(fixture.clone, ".dim/ci/runner.yml"), wrongKindRunner());
    await runGit("/usr/bin/git", ["-C", fixture.clone, "add", ".dim/ci/runner.yml"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "commit", "-m", "move integration kind"]);
    await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const envelope = await createBundleReview(fixture.service);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const derive = fixture.service.deriveOrdinaryExecutionDescriptor({
      projectId: "project-a", reviewId: envelope.review.reviewId, jobName: "source", trustedCapacity
    });

    // Then
    await expect(derive).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });

  it.each(["proposal", "head", "policy"] as const)("rejects a review after %s drift without mutation", async (drift) => {
    // Given
    const fixture = await nativeBundleReviewFixture(`ordinary-stale-${drift}`);
    const envelope = await createBundleReview(fixture.service);
    if (drift === "proposal") {
      await writeFile(join(fixture.clone, "late-change.txt"), "late\n");
      await runGit("/usr/bin/git", ["-C", fixture.clone, "add", "late-change.txt"]);
      await runGit("/usr/bin/git", ["-C", fixture.clone, "commit", "-m", "move proposal"]);
      await runGit("/usr/bin/git", ["-C", fixture.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    } else if (drift === "head") {
      await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref", "refs/heads/main",
        envelope.review.candidateCommit, envelope.review.expectedProtectedHead]);
    } else {
      replacePolicy(fixture.root, authoritativePolicy(["foreign", "owner"]));
    }
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const derive = fixture.service.deriveOrdinaryExecutionDescriptor({
      projectId: "project-a", reviewId: envelope.review.reviewId, jobName: "source", trustedCapacity
    });

    // Then
    await expect(derive).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });

  it("rejects caller-supplied authority overrides", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("ordinary-overrides");
    const envelope = await createBundleReview(fixture.service);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const derive = fixture.service.deriveOrdinaryExecutionDescriptor({
      projectId: "project-a",
      reviewId: envelope.review.reviewId,
      jobName: "source",
      trustedCapacity,
      candidateTree: envelope.review.candidateTree
    });

    // Then
    await expect(derive).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });
});

async function authoritySnapshot(root: string, reviewId: string): Promise<unknown> {
  const repository = rootRepository(root);
  return {
    state: await readFile(join(root, "native-idle.sqlite3")),
    repositoryEntries: (await readdir(repository)).sort(),
    review: await readFile(join(repository, "dim-authoritative-reviews", "proposals", `${reviewId}.json`)),
    protectedHead: (await runGit("/usr/bin/git", ["--git-dir", repository, "rev-parse", "refs/heads/main"])).stdout.trim(),
    proposalHead: (await runGit("/usr/bin/git", ["--git-dir", repository, "rev-parse", reviewProposalRef])).stdout.trim()
  };
}

async function gitObjectId(repository: string, tree: string, path: string): Promise<string> {
  return (await runGit("/usr/bin/git", ["--git-dir", repository, "rev-parse", `${tree}:${path}`])).stdout.trim();
}

function replacePolicy(root: string, policy: object): void {
  const policyJson = JSON.stringify(policy);
  const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
  database.prepare("UPDATE native_project_root_import SET policy_json = ?, policy_sha256 = ?")
    .run(policyJson, createHash("sha256").update(policyJson).digest("hex"));
  database.close();
}
