import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sysboxBackend } from "../../../packages/host/plugins/ci-worker/src/backends/sysbox.js";
import type { NativeCandidateReadAuthority } from "../../../packages/host/plugins/ci-worker/src/candidate.js";
import { executionDescriptorDigest } from "../../../packages/contracts/ci/src/execution-protocol.js";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { assignment, grant } from "../../contracts/ci/executionFixture.js";

const runner = new ProcessRunner();
const dockerInfo = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], { signal: AbortSignal.timeout(30_000) });
const runnerImage = process.env.DIM_TEST_NATIVE_RUNNER_IMAGE;
const jobImage = process.env.DIM_TEST_NATIVE_JOB_IMAGE;
describe("Sysbox execution backend with the real Docker daemon", () => {
  it("uses the registered Sysbox runtime", () => {
    expect(dockerInfo.exitCode).toBe(0);
    expect(Object.hasOwn(JSON.parse(dockerInfo.stdout) as object, "sysbox-runc")).toBe(true);
  });
  it("runs a digest-pinned nested job and returns evidence after owned cleanup", async () => {
    if (!runnerImage?.includes("@sha256:") || !jobImage?.includes("@sha256:")) throw new Error("digest fixture images are required");
    const root = await mkdtemp(join(tmpdir(), "dim-sysbox-live-"));
    const selected = grant(assignment());
    const config = Buffer.from("jobs:\n  source:\n    script: scripts/check.sh\n"), script = Buffer.from("printf 'native-live-output\\n'\n");
    const descriptor = { ...selected.descriptor, runnerBaseImage: runnerImage, jobImage, bounds: { ...selected.descriptor.bounds, wallClockSeconds: "90" },
      configBlob: { ...selected.descriptor.configBlob, sha256: digest(config) },
      script: { ...selected.descriptor.script, sha256: digest(script) } };
    const authority: NativeCandidateReadAuthority = {
      async resolveProtectedHead() { return descriptor.expectedProtectedHead; },
      async readCommit() { return { objectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree }; },
      async readBlob(input) { return input.path === descriptor.configBlob.path
        ? { objectId: descriptor.configBlob.objectId, mode: "100644", bytes: config }
        : { objectId: descriptor.script.objectId, mode: "100755", bytes: script }; },
      async materializeTree(input) { await mkdir(input.destination); await writeFile(join(input.destination, "README"), "verified candidate\n");
        return { commitObjectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree }; }
    };
    try {
      const completed = await sysboxBackend.run({ runner, root, authority, signal: AbortSignal.timeout(110_000),
        grant: { ...selected, descriptor, descriptorDigest: executionDescriptorDigest(descriptor) } });
      expect(completed.result, JSON.stringify({ completion: completed.completion, stdout: Buffer.from(completed.logs.stdout.base64, "base64").toString(), stderr: Buffer.from(completed.logs.stderr.base64, "base64").toString() })).toBe("success"); expect(completed.cleanupComplete).toBe(true);
      expect(completed.stdout.sha256).toBe(digest(Buffer.from("native-live-output\n")));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
function digest(bytes: Buffer): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
