import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFinalizeFixtures,
  runGit
} from "../git-repositories/nativeRootImportFinalizeFixture.js";
import {
  addCandidateCommit,
  createBundleReview,
  nativeBundleReviewFixture,
  publishedReviewEnvelopes,
  publishedReviewNames,
  reviewProposalRef,
  waitForPublishedReview
} from "./nativeBundleReviewFixture.js";
import { authoritativePolicy } from "../git-repositories/authoritativeNativeCandidateFixture.js";
import { createAuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-ci/src/plan-schema.js";

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
    const changed = await waitForPublishedReview(fixture.root, candidate);
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
    runtime: vm
  smoke:
    script: .dim/ci/jobs/smoke.bash
    runtime: vm
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
    const added = await waitForPublishedReview(fixture.root, candidate);
    expect(added?.events.map(({ executionKind, jobName }) => ({ executionKind, jobName }))).toEqual([
      { executionKind: "ordinary-sysbox", jobName: "lint" },
      { executionKind: "ordinary-sysbox", jobName: "source" },
      { executionKind: "qemu", jobName: "integration" },
      { executionKind: "qemu", jobName: "smoke" }
    ]);
    expect(new Set(added?.events.map(({ eventId }) => eventId)).size).toBe(4);
  });

  it("eventually publishes one exact candidate envelope after a successful proposal push", async () => {
    // Given / When
    const fixture = await nativeBundleReviewFixture("bundle-review-automatic");

    // Then
    const names = await publishedReviewNames(fixture.root);
    expect(names).toHaveLength(1);
    const resolved = await createBundleReview(fixture.service);
    expect(names[0]).toMatch(new RegExp(`^${resolved.review.reviewId}\\.[a-f0-9]{64}\\.json$`));
    expect(resolved.events.map(({ executionKind, jobName }) => ({ executionKind, jobName }))).toEqual([
      { executionKind: "ordinary-sysbox", jobName: "source" },
      { executionKind: "qemu", jobName: "integration" }
    ]);
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
    expect((await publishedReviewNames(fixture.root)).some((name) => name.startsWith(`${created.review.reviewId}.`))).toBe(true);
  });

  it("binds quality policy revision to a new human review identity and events", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("bundle-review-quality-revision");
    const original = await createBundleReview(fixture.service);
    const { reviewId: _reviewId, createdAt, ...identity } = original.review;

    // When
    const revised = createAuthoritativeNativeReviewEnvelope({ identity: { ...identity, policyRevision: "c".repeat(64), requiredReviewRevision: "c".repeat(64) },
      qualityRevision: "a".repeat(64), policyDigest: "b".repeat(64), requiredJobs: [],
      planning: original.planning, createdAt });

    // Then
    expect(revised.review.reviewId).not.toBe(original.review.reviewId);
    expect(revised.envelopeId).not.toBe(original.envelopeId);
    expect(revised.events.map(({ eventId }) => eventId)).not.toEqual(original.events.map(({ eventId }) => eventId));
  });
});
