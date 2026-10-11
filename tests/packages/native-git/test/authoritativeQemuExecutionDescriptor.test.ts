import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateExecutionError,
  candidateArgv,
  candidateOrdinaryExecutionDescriptorSchema,
  descriptorDigest,
  qemuExecutionDescriptorDigest,
  qemuExecutionDescriptorSchema
} from "../../../../core/packages/native-git/src/index.js";
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
  admissionGeneration: "qemu-generation-3",
  jobBaseImage: `registry.example/qemu-job@sha256:${"c".repeat(64)}`,
  runnerBaseImage: `registry.example/qemu-runner@sha256:${"d".repeat(64)}`,
  bounds: {
    cpu: "4",
    memoryBytes: "4294967296",
    pids: "1024",
    wallClockSeconds: "1800",
    outputBytes: "20971520"
  }
} as const;

describe("authoritative QEMU execution descriptor", () => {
  it("derives exact QEMU provenance from the current immutable review without mutation", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("qemu-descriptor");
    const envelope = await createBundleReview(fixture.service);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const result = await fixture.service.deriveQemuExecutionDescriptor({
      projectId: "project-a",
      reviewId: envelope.review.reviewId,
      jobName: "integration",
      trustedCapacity
    });

    // Then
    const repository = rootRepository(fixture.root);
    const configObjectId = await gitObjectId(repository, envelope.review.candidateTree, ".dim/ci/runner.yml");
    const scriptObjectId = await gitObjectId(repository, envelope.review.candidateTree, ".dim/ci/jobs/integration.bash");
    expect(result).toEqual({
      kind: "qemu",
      reviewId: envelope.review.reviewId,
      descriptor: {
        schemaVersion: 1,
        executionKind: "qemu",
        admissionGeneration: trustedCapacity.admissionGeneration,
        jobName: "integration",
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
          path: ".dim/ci/jobs/integration.bash",
          objectId: scriptObjectId,
          sha256: digest("set -euo pipefail\nprintf 'integration\\n'\n")
        },
        argv: candidateArgv,
        jobImage: trustedCapacity.jobBaseImage
      },
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    expect(result.digest).toBe(qemuExecutionDescriptorDigest(result.descriptor));
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });

  it("uses a QEMU domain distinct from ordinary evidence for identical provenance", () => {
    // Given
    const provenance = {
      admissionGeneration: trustedCapacity.admissionGeneration,
      jobName: "integration",
      runnerBaseImage: trustedCapacity.runnerBaseImage,
      bounds: trustedCapacity.bounds,
      projectId: "project-a",
      repositoryId: "root",
      protectedRef: "refs/heads/main",
      expectedProtectedHead: "1".repeat(40),
      candidateCommit: "2".repeat(40),
      candidateTree: "3".repeat(40),
      policyRevision: "policy-1",
      requiredReviewRevision: "review-1",
      requiredJobSetRevision: "jobs-1",
      evidenceClass: "candidate-controlled",
      configBlob: { objectId: "4".repeat(40), sha256: `sha256:${"5".repeat(64)}` },
      script: {
        path: ".dim/ci/jobs/integration.bash",
        objectId: "6".repeat(40),
        sha256: `sha256:${"7".repeat(64)}`
      },
      argv: candidateArgv,
      jobImage: trustedCapacity.jobBaseImage
    } as const;
    const ordinary = candidateOrdinaryExecutionDescriptorSchema.parse(provenance);
    const qemu = qemuExecutionDescriptorSchema.parse({ schemaVersion: 1, executionKind: "qemu", ...provenance });

    // When
    const ordinaryDigest = descriptorDigest(ordinary);
    const qemuDigest = qemuExecutionDescriptorDigest(qemu);

    // Then
    expect(qemuDigest).toBe("sha256:adb79854c9584b42a7988554d7552ac79c977597511f200548ed254d35f37f6f");
    expect(qemuDigest).not.toBe(ordinaryDigest);
  });

  it.each([
    ["ordinary review job", "source", matchingRunner()],
    ["wrong-kind candidate map", "integration", wrongKindRunner()]
  ] as const)("rejects %s without mutation", async (_case, jobName, runner) => {
    // Given
    const fixture = await nativeBundleReviewFixture(`qemu-kind-${jobName}`);
    if (runner !== matchingRunner()) await replaceCandidateRunner(fixture.clone, runner);
    const envelope = await createBundleReview(fixture.service);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const derive = fixture.service.deriveQemuExecutionDescriptor({
      projectId: "project-a", reviewId: envelope.review.reviewId, jobName, trustedCapacity
    });

    // Then
    await expect(derive).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });

  it.each(["proposal", "head", "policy"] as const)("rejects a review after %s drift without mutation", async (drift) => {
    // Given
    const fixture = await nativeBundleReviewFixture(`qemu-stale-${drift}`);
    const envelope = await createBundleReview(fixture.service);
    await createDrift(fixture.root, fixture.clone, envelope.review, drift);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const derive = fixture.service.deriveQemuExecutionDescriptor({
      projectId: "project-a", reviewId: envelope.review.reviewId, jobName: "integration", trustedCapacity
    });

    // Then
    await expect(derive).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });

  it("rejects caller-supplied authority fields without mutation", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("qemu-overrides");
    const envelope = await createBundleReview(fixture.service);
    const before = await authoritySnapshot(fixture.root, envelope.review.reviewId);

    // When
    const derive = fixture.service.deriveQemuExecutionDescriptor({
      projectId: "project-a",
      reviewId: envelope.review.reviewId,
      jobName: "integration",
      trustedCapacity,
      executionKind: "qemu"
    });

    // Then
    await expect(derive).rejects.toBeInstanceOf(CandidateExecutionError);
    expect(await authoritySnapshot(fixture.root, envelope.review.reviewId)).toEqual(before);
  });
});

async function replaceCandidateRunner(clone: string, runner: string): Promise<void> {
  await writeFile(join(clone, ".dim/ci/runner.yml"), runner);
  await runGit("/usr/bin/git", ["-C", clone, "add", ".dim/ci/runner.yml"]);
  await runGit("/usr/bin/git", ["-C", clone, "commit", "-m", "change runner kind"]);
  await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
}

async function createDrift(
  root: string,
  clone: string,
  review: { readonly candidateCommit: string; readonly expectedProtectedHead: string },
  drift: "proposal" | "head" | "policy"
): Promise<void> {
  if (drift === "proposal") {
    await writeFile(join(clone, "late-qemu-change.txt"), "late\n");
    await runGit("/usr/bin/git", ["-C", clone, "add", "late-qemu-change.txt"]);
    await runGit("/usr/bin/git", ["-C", clone, "commit", "-m", "move proposal"]);
    await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
  } else if (drift === "head") {
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "update-ref", "refs/heads/main",
      review.candidateCommit, review.expectedProtectedHead]);
  } else {
    replacePolicy(root, authoritativePolicy(["foreign", "owner"]));
  }
}

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
