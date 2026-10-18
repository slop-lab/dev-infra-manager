import { readNativeCandidateJobInputsFromGit } from "../../../../core/packages/native-git/src/native-candidate-job-inputs.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateExecutionError } from "../../../../core/packages/native-git/src/index.js";
import type { WorkflowCompiler } from "../../../../core/packages/native-git/src/workflowCompiler.js";
import { nativeCandidateJobInputsFixture, type NativeCandidateJobInputsFixture } from "./nativeCandidateJobInputsHarness.js";

const fixtures: NativeCandidateJobInputsFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

const compiler: WorkflowCompiler = {
  configurationPath: "build/jobs.json",
  compile(bytes) {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed !== "run-check") throw new Error("invalid custom workflow");
    return [{ name: "check", kind: "ordinary-sysbox", script: "build/check.sh",
      argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"] }];
  }
};

describe("Git workflow compiler boundary", () => {
  it("reads a compiler-owned configuration path and hashes scripts outside the default language directory", async () => {
    const fixture = await nativeCandidateJobInputsFixture("sha1");
    fixtures.push(fixture);
    await mkdir(join(fixture.source, "build"));
    await writeFile(join(fixture.source, compiler.configurationPath), JSON.stringify("run-check"));
    await writeFile(join(fixture.source, "build/check.sh"), "printf 'custom workflow\\n'\n");
    const candidate = await fixture.commit("custom workflow language");

    const inputs = await readNativeCandidateJobInputsFromGit(fixture.reader, candidate, compiler);

    expect(inputs.configBlob?.path).toBe(compiler.configurationPath);
    expect(inputs.plan).toEqual([expect.objectContaining({ name: "check", script: expect.objectContaining({
      path: "build/check.sh", objectId: expect.stringMatching(/^[0-9a-f]{40}$/)
    }) })]);
  });

  it("canonicalizes arbitrary compiler order before constructing authority envelopes", async () => {
    const fixture = await nativeCandidateJobInputsFixture("sha1");
    fixtures.push(fixture);
    const unordered: WorkflowCompiler = { configurationPath: ".dim/ci/runner.yml", compile() {
      return [
        { name: "integration", kind: "qemu", script: ".dim/ci/jobs/integration.bash", argv: ["/bin/sh"] },
        { name: "source", kind: "ordinary-sysbox", script: ".dim/ci/jobs/source.bash", argv: ["/bin/sh"] }
      ];
    } };

    const inputs = await readNativeCandidateJobInputsFromGit(fixture.reader, fixture.input, unordered);

    expect(inputs.plan.map(({ name }) => name)).toEqual(["source", "integration"]);
  });

  it("rejects an unsafe compiler configuration path before repository path lookup", async () => {
    const fixture = await nativeCandidateJobInputsFixture("sha1");
    fixtures.push(fixture);
    await expect(readNativeCandidateJobInputsFromGit(fixture.reader, fixture.input,
      { ...compiler, configurationPath: "../host-secret" })).rejects.toBeInstanceOf(CandidateExecutionError);
  });

  it("rejects compiler output that escapes the candidate tree", async () => {
    const fixture = await nativeCandidateJobInputsFixture("sha1");
    fixtures.push(fixture);
    const unsafeCompiler: WorkflowCompiler = { configurationPath: ".dim/ci/runner.yml", compile() {
      return [{ name: "check", kind: "ordinary-sysbox", script: "../host-secret", argv: ["/bin/sh"] }];
    } };
    await expect(readNativeCandidateJobInputsFromGit(fixture.reader, fixture.input, unsafeCompiler))
      .rejects.toThrow();
  });
});
