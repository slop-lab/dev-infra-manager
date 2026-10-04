import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateExecutionError,
  loadCandidateOrdinaryExecution,
  type NativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";
import {
  candidateExecutionFixture,
  forgedCandidateWithAncestor,
  git,
  gitInput,
  imageDigest,
  validRunnerYaml,
  writeRawTree,
  type CandidateExecutionFixture
} from "./candidateExecutionHarness.js";
import { isExitError, nativeGitFixture, refValue, type NativeGitFixture } from "./nativeGitHarness.js";

const candidateFixtures: CandidateExecutionFixture[] = [];
const nativeFixtures: NativeGitFixture[] = [];

afterEach(async () => {
  await Promise.all([
    ...candidateFixtures.splice(0).map((fixture) => fixture.close()),
    ...nativeFixtures.splice(0).map((fixture) => fixture.close())
  ]);
});

describe("native candidate execution boundary hardening", () => {
  it.each(["120000", "160000"] as const)("rejects a raw tree with a %s .dim ancestor and slash-named blobs", async (mode) => {
    // Given
    const fixture = await candidateFixture();
    const request = await forgedCandidateWithAncestor(fixture, mode);

    // When / Then
    await expect(loadCandidateOrdinaryExecution(fixture.config, request)).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it("rejects typed and quoted job keys that normalize to the same string", async () => {
    // Given
    const fixture = await candidateFixture();
    const yaml = validRunnerYaml().replace(
      "    source:",
      `    true:\n      image: ${imageDigest}\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n    "true":`
    );
    await writeFile(join(fixture.source, ".dim/ci/runner.yml"), yaml);
    const request = { ...(await fixture.commit("normalized duplicate job keys")), jobName: "true" };
    const config: NativeGitServiceConfig = {
      ...fixture.config,
      repositories: fixture.config.repositories.map((repository) => ({
        ...repository,
        reviewPolicies: repository.reviewPolicies?.map((policy) => ({ ...policy, requiredJobNames: ["true"] }))
      })),
      identities: fixture.config.identities.map((identity) => identity.role === "ci"
        ? { ...identity, jobName: "true" }
        : identity)
    };

    // When / Then
    await expect(loadCandidateOrdinaryExecution(config, request)).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it("rejects a digest reference with a port in a repository path component", async () => {
    // Given
    const fixture = await candidateFixture();
    const invalidImage = `registry.example/ns:123/repo@sha256:${"3".repeat(64)}`;
    await writeFile(join(fixture.source, ".dim/ci/runner.yml"), validRunnerYaml(invalidImage));
    const request = await fixture.commit("Docker-invalid image");

    // When / Then
    await expect(loadCandidateOrdinaryExecution(fixture.config, request)).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it("rejects a forged slash-named tree through authenticated HTTP receive-pack", async () => {
    // Given
    const fixture = await nativeFixture();
    const clone = join(fixture.root, "forged-writer");
    await fixture.git(fixture.root, ["clone", fixture.repositoryPath("project-a", "source"), clone]);
    await fixture.git(clone, ["config", "user.name", "DIM attacker"]);
    await fixture.git(clone, ["config", "user.email", "attacker@example.invalid"]);
    await mkdir(join(clone, ".dim/ci/jobs"), { recursive: true });
    await writeFile(join(clone, ".dim/ci/runner.yml"), validRunnerYaml());
    await writeFile(join(clone, ".dim/ci/jobs/source.bash"), "exit 0\n");
    const configObjectId = (await gitInput(clone, ["hash-object", "-w", "--stdin"], Buffer.from(validRunnerYaml()))).stdout.trim();
    const scriptObjectId = (await gitInput(clone, ["hash-object", "-w", "--stdin"], Buffer.from("exit 0\n"))).stdout.trim();
    const symlinkObjectId = (await gitInput(clone, ["hash-object", "-w", "--stdin"], Buffer.from("ci"))).stdout.trim();
    const tree = await writeRawTree(clone, [], [
      { mode: "120000", name: ".dim", objectId: symlinkObjectId },
      { mode: "100644", name: ".dim/ci/jobs/source.bash", objectId: scriptObjectId },
      { mode: "100644", name: ".dim/ci/runner.yml", objectId: configObjectId }
    ]);
    const parent = (await git(clone, ["rev-parse", "HEAD"])).stdout.trim();
    const commit = (await git(clone, ["commit-tree", tree, "-p", parent, "-m", "forged HTTP candidate"])).stdout.trim();

    // When
    const push = fixture.git(clone, ["push", fixture.url("writer-a", "writer-a-secret-1", "project-a", "source"), `${commit}:refs/heads/proposals/workspace-a/forged-tree`]);

    // Then
    await expect(push).rejects.toSatisfy((error: unknown) =>
      isExitError(error) && /unpacker error|fsck|fullPathname/.test(error.stderr)
    );
    await expect(refValue(fixture.repositoryPath("project-a", "source"), "refs/heads/proposals/workspace-a/forged-tree"))
      .resolves.toBeUndefined();
  });
});

async function candidateFixture(): Promise<CandidateExecutionFixture> {
  const fixture = await candidateExecutionFixture();
  candidateFixtures.push(fixture);
  return fixture;
}

async function nativeFixture(): Promise<NativeGitFixture> {
  const fixture = await nativeGitFixture();
  nativeFixtures.push(fixture);
  return fixture;
}
