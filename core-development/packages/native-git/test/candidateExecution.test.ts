import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateExecutionError,
  loadCandidateOrdinaryExecution
} from "../../../../core/packages/native-git/src/index.js";
import {
  candidateExecutionFixture,
  git,
  imageDigest,
  replaceScriptWithSymlink,
  validRunnerYaml,
  type CandidateExecutionFixture
} from "./candidateExecutionHarness.js";

const fixtures: CandidateExecutionFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native candidate ordinary execution descriptors", () => {
  it("returns the immutable descriptor and independently framed digest from a real bare repository", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const result = await loadCandidateOrdinaryExecution(fixture.config, fixture.request);

    // Then
    const configObjectId = await objectId(fixture, ".dim/ci/runner.yml");
    const scriptObjectId = await objectId(fixture, ".dim/ci/jobs/source.bash");
    const configSha256 = sha256(Buffer.from(validRunnerYaml()));
    const scriptSha256 = sha256(Buffer.from("set -euo pipefail\nprintf 'verified\\n'\n"));
    const { jobBaseImage, ...descriptorRequest } = fixture.request;
    expect(result.descriptor).toEqual({
      ...descriptorRequest,
      evidenceClass: "candidate-controlled",
      configBlob: { objectId: configObjectId, sha256: configSha256 },
      script: { path: ".dim/ci/jobs/source.bash", objectId: scriptObjectId, sha256: scriptSha256 },
      argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
      jobImage: jobBaseImage
    });
    const fields = [
      fixture.request.projectId, fixture.request.repositoryId, fixture.request.protectedRef,
      fixture.request.expectedProtectedHead, fixture.request.candidateCommit, fixture.request.candidateTree,
      fixture.request.policyRevision, fixture.request.requiredReviewRevision,
      fixture.request.requiredJobSetRevision, fixture.request.admissionGeneration, fixture.request.jobName,
      "candidate-controlled", configObjectId, configSha256, ".dim/ci/jobs/source.bash",
      scriptObjectId, scriptSha256, "/bin/bash", "--noprofile", "--norc", "/run/dim/job/script",
      imageDigest, fixture.request.runnerBaseImage, "2", "2147483648", "512", "900", "10485760"
    ];
    const framed = `dim-native-ordinary-execution-v1${fields.map((field) => `${Buffer.byteLength(field)}:${field}`).join("")}`;
    expect(result.digest).toBe(`sha256:${createHash("sha256").update(framed).digest("hex")}`);
  });

  it.each([
    ["an alias", "base: &job\n  script: .dim/ci/jobs/source.bash\nschemaVersion: 3\nordinary:\n  jobs:\n    source: *job\n"],
    ["an anchor", validRunnerYaml().replace("source:", "source: &source")],
    ["an explicit tag", validRunnerYaml().replace("schemaVersion: 3", "schemaVersion: !!int 3")],
    ["a merge key", validRunnerYaml().replace("      script:", "      <<: {}\n      script:")],
    ["a duplicate key", `${validRunnerYaml()}schemaVersion: 3\n`],
    ["a NUL", `${validRunnerYaml()}\0`],
    ["schema version 2", validRunnerYaml().replace("schemaVersion: 3", "schemaVersion: 2")],
    ["an unknown key", `${validRunnerYaml()}unexpected: value\n`],
    ["a candidate-selected image", validRunnerYaml().replace("      script:", `      image: ${imageDigest}\n      script:`)],
    ["a traversing script", validRunnerYaml().replace(".dim/ci/jobs/source.bash", ".dim/ci/jobs/../source.bash")],
    ["candidate-selected argv", validRunnerYaml().replace("/run/dim/job/script", "/workspace/test.bash")]
  ])("rejects runner YAML containing %s", async (_label, yaml) => {
    // Given
    const fixture = await startFixture();
    await writeFile(join(fixture.source, ".dim/ci/runner.yml"), yaml);
    const request = await fixture.commit("malicious yaml");

    // When / Then
    await expect(loadCandidateOrdinaryExecution(fixture.config, request)).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it("rejects missing, symbolic-link, gitlink, and oversized scripts", async () => {
    // Given
    const fixture = await startFixture();
    const script = join(fixture.source, ".dim/ci/jobs/source.bash");
    const attempts: Array<() => Promise<typeof fixture.request>> = [
      async () => { await rm(script); return fixture.commit("missing script"); },
      async () => { await writeFile(script, "exit 0\n"); await fixture.commit("restore script"); await replaceScriptWithSymlink(fixture); return fixture.commit("symlink script"); },
      async () => {
        await rm(script);
        await git(fixture.source, ["update-index", "--add", "--cacheinfo", `160000,${fixture.request.candidateCommit},.dim/ci/jobs/source.bash`]);
        await git(fixture.source, ["commit", "-m", "gitlink script"]);
        await git(fixture.root, ["--git-dir", fixture.repositoryPath, "fetch", fixture.source, "+refs/heads/main:refs/heads/main"]);
        return { ...fixture.request, candidateCommit: (await git(fixture.source, ["rev-parse", "HEAD"])).stdout.trim(), candidateTree: (await git(fixture.source, ["rev-parse", "HEAD^{tree}"])).stdout.trim() };
      },
      async () => { await git(fixture.source, ["rm", "--cached", ".dim/ci/jobs/source.bash"]); await writeFile(script, Buffer.alloc(1024 * 1024 + 1, 97)); return fixture.commit("oversized script"); }
    ];

    // When / Then
    for (const attempt of attempts) {
      const request = await attempt();
      await expect(loadCandidateOrdinaryExecution(fixture.config, request)).rejects.toBeInstanceOf(CandidateExecutionError);
    }
  });

  it("rejects oversized config, extra policy jobs, and changed candidate tree identity", async () => {
    // Given
    const fixture = await startFixture();
    await rm(join(fixture.source, ".dim/ci/runner.yml"));
    const missing = await fixture.commit("missing config");
    await writeFile(join(fixture.source, ".dim/ci/runner.yml"), `${validRunnerYaml()}#${"x".repeat(65_536)}\n`);
    const oversized = await fixture.commit("oversized config");
    await writeFile(join(fixture.source, ".dim/ci/runner.yml"), validRunnerYaml().replace(
      "    source:",
      "    extra:\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n    source:"
    ));
    const extraJob = await fixture.commit("extra job");
    await writeFile(join(fixture.source, ".dim/ci/runner.yml"), `${validRunnerYaml()}# changed blob\n`);
    const changed = await fixture.commit("changed config blob");

    // When / Then
    await expect(loadCandidateOrdinaryExecution(fixture.config, missing)).rejects.toBeInstanceOf(CandidateExecutionError);
    await expect(loadCandidateOrdinaryExecution(fixture.config, oversized)).rejects.toBeInstanceOf(CandidateExecutionError);
    await expect(loadCandidateOrdinaryExecution(fixture.config, extraJob)).rejects.toBeInstanceOf(CandidateExecutionError);
    await expect(loadCandidateOrdinaryExecution(fixture.config, { ...changed, candidateTree: fixture.request.candidateTree }))
      .rejects.toBeInstanceOf(CandidateExecutionError);
  });
});

async function startFixture(): Promise<CandidateExecutionFixture> {
  const fixture = await candidateExecutionFixture();
  fixtures.push(fixture);
  return fixture;
}

async function objectId(fixture: CandidateExecutionFixture, path: string): Promise<string> {
  return (await git(fixture.root, ["--git-dir", fixture.repositoryPath, "rev-parse", `${fixture.request.candidateTree}:${path}`])).stdout.trim();
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
