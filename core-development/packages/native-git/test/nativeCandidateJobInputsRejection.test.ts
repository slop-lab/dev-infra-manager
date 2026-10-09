import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateExecutionError,
  loadNativeCandidateJobInputs
} from "../../../../core/packages/native-git/src/index.js";
import { git } from "./candidateExecutionHarness.js";
import {
  nativeCandidateJobInputsFixture,
  nativeRunnerYaml,
  type NativeCandidateJobInputsFixture
} from "./nativeCandidateJobInputsHarness.js";

const fixtures: NativeCandidateJobInputsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native schema-4 candidate job input rejection", () => {
  it("rejects stale heads, foreign repositories, commit/tree mismatch, and wrong job-kind policy", async () => {
    // Given
    const fixture = await startFixture();
    await writeFile(join(fixture.source, "moved.txt"), "moved\n");
    await fixture.commit("move protected head");
    const malformed = [
      fixture.input,
      { ...fixture.input, repositoryId: "foreign" },
      { ...fixture.input, protectedRef: "refs/heads/foreign" },
      { ...fixture.input, candidateTree: "0".repeat(fixture.input.candidateTree.length) },
      { ...fixture.input, candidateCommit: "0".repeat(fixture.input.candidateCommit.length) },
      { ...fixture.input, unexpected: true },
      { ...fixture.input, requiredJobs: fixture.input.requiredJobs.map((job) => ({
        ...job,
        kind: job.kind === "qemu" ? "ordinary-sysbox" as const : "qemu" as const
      })) }
    ];

    // When / Then
    for (const input of malformed) {
      await expect(loadNativeCandidateJobInputs(fixture.config, input)).rejects.toBeInstanceOf(CandidateExecutionError);
    }
  });

  it("rejects a caller job outside the registered protected policy", async () => {
    // Given: the registered protected policy requires only the ordinary job.
    const fixture = await startFixture();
    const config = { ...fixture.config, repositories: fixture.config.repositories.map((repository) => ({
      ...repository,
      reviewPolicies: repository.reviewPolicies?.map((policy) => ({ ...policy, requiredJobNames: ["source"] }))
    })) };

    // When: the caller includes the candidate's extra QEMU job as required.
    const read = loadNativeCandidateJobInputs(config, fixture.input);

    // Then: the service library refuses to describe an unregistered required job.
    await expect(read).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it.each([
    ["config symlink", ".dim/ci/runner.yml", "120000"],
    ["config gitlink", ".dim/ci/runner.yml", "160000"],
    ["script symlink", ".dim/ci/jobs/source.bash", "120000"],
    ["script gitlink", ".dim/ci/jobs/integration.bash", "160000"]
  ] as const)("rejects a nonregular %s", async (_label, path, mode) => {
    // Given
    const fixture = await startFixture();
    const absolutePath = join(fixture.source, path);
    await rm(absolutePath);
    if (mode === "120000") {
      await symlink("../../../README.md", absolutePath);
    } else {
      await git(fixture.source, ["update-index", "--add", "--cacheinfo", `${mode},${fixture.input.candidateCommit},${path}`]);
    }
    const input = await fixture.commit(`nonregular ${path}`);

    // When / Then
    await expect(loadNativeCandidateJobInputs(fixture.config, input)).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it.each([
    ["config", ".dim/ci/runner.yml", `${nativeRunnerYaml()}#${"x".repeat(65_536)}`],
    ["script", ".dim/ci/jobs/source.bash", "x".repeat(1024 * 1024 + 1)]
  ])("rejects an oversized %s", async (_label, path, content) => {
    // Given
    const fixture = await startFixture();
    await writeFile(join(fixture.source, path), content);
    const input = await fixture.commit(`oversized ${path}`);

    // When / Then
    await expect(loadNativeCandidateJobInputs(fixture.config, input)).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it("wraps arbitrary Git failures in a stable typed error", async () => {
    // Given
    const fixture = await startFixture();
    const input = { ...fixture.input, candidateCommit: "f".repeat(fixture.input.candidateCommit.length) };

    // When
    const failure = loadNativeCandidateJobInputs(fixture.config, input);

    // Then
    await expect(failure).rejects.toMatchObject({
      name: "CandidateExecutionError",
      message: "Git could not read the candidate object"
    });
  });
});

async function startFixture(): Promise<NativeCandidateJobInputsFixture> {
  const fixture = await nativeCandidateJobInputsFixture("sha1");
  fixtures.push(fixture);
  return fixture;
}
