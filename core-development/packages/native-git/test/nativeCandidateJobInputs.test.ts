import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateArgv,
  loadNativeCandidateJobInputs
} from "../../../../core/packages/native-git/src/index.js";
import { git } from "./candidateExecutionHarness.js";
import {
  integrationScript,
  nativeCandidateJobInputsFixture,
  nativeRunnerYaml,
  sourceScript,
  type NativeCandidateJobInputsFixture
} from "./nativeCandidateJobInputsHarness.js";

const fixtures: NativeCandidateJobInputsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native schema-4 candidate job inputs", () => {
  it.each(["sha1", "sha256"] as const)("returns deterministic identity-only inputs from a real %s repository", async (format) => {
    // Given
    const fixture = await startFixture(format);
    const refsBefore = await refs(fixture);

    // When
    const result = await loadNativeCandidateJobInputs(fixture.config, fixture.input);

    // Then
    expect(result).toEqual({
      configBlob: {
        objectId: await objectId(fixture, ".dim/ci/runner.yml"),
        sha256: sha256(nativeRunnerYaml())
      },
      plan: [
        {
          name: "source",
          kind: "ordinary-sysbox",
          script: {
            path: ".dim/ci/jobs/source.bash",
            objectId: await objectId(fixture, ".dim/ci/jobs/source.bash"),
            sha256: sha256(sourceScript())
          },
          argv: candidateArgv
        },
        {
          name: "integration",
          kind: "qemu",
          script: {
            path: ".dim/ci/jobs/integration.bash",
            objectId: await objectId(fixture, ".dim/ci/jobs/integration.bash"),
            sha256: sha256(integrationScript())
          },
          argv: candidateArgv
        }
      ]
    });
    expect(JSON.stringify(result)).not.toMatch(/image|bound|token|credential|bytes/);
    expect(await refs(fixture)).toBe(refsBefore);
  });
});

async function startFixture(format: "sha1" | "sha256"): Promise<NativeCandidateJobInputsFixture> {
  const fixture = await nativeCandidateJobInputsFixture(format);
  fixtures.push(fixture);
  return fixture;
}

async function objectId(fixture: NativeCandidateJobInputsFixture, path: string): Promise<string> {
  return (await git(fixture.root, [
    "--git-dir", fixture.repositoryPath, "rev-parse", `${fixture.input.candidateTree}:${path}`
  ])).stdout.trim();
}

async function refs(fixture: NativeCandidateJobInputsFixture): Promise<string> {
  return (await git(fixture.root, ["--git-dir", fixture.repositoryPath, "show-ref"])).stdout;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
