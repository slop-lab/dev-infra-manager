import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sysboxBackend } from "../../../../../core/packages/managed/src/ci/backends/sysbox.js";
import { executionDescriptorDigest } from "../../../../../core/packages/native-git/src/execution-protocol.js";
import type { NativeCandidateReadAuthority } from "../../../../../core/packages/managed/src/nativeOrdinaryCandidateVerifier.js";
import { assignment, grant, hash } from "./executionFixture.js";
import { ExecutorRunner } from "./sysboxFixture.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function input() {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-sysbox-")); roots.push(root);
  const selected = grant(assignment()), script = Buffer.from("printf 'executor-output\\n'\n"), config = Buffer.from("jobs: {}\n");
  const descriptor = { ...selected.descriptor, script: { ...selected.descriptor.script, sha256: `sha256:${hash(script.toString())}` },
    configBlob: { ...selected.descriptor.configBlob, sha256: `sha256:${hash(config.toString())}` } };
  const authority: NativeCandidateReadAuthority = {
    async resolveProtectedHead() { return descriptor.expectedProtectedHead; },
    async readCommit() { return { objectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree }; },
    async readBlob(input) { return input.path === descriptor.configBlob.path
      ? { objectId: descriptor.configBlob.objectId, mode: "100644", bytes: config }
      : { objectId: descriptor.script.objectId, mode: "100755", bytes: script }; },
    async materializeTree(input) { await mkdir(input.destination); await writeFile(join(input.destination, "README"), "candidate");
      return { commitObjectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree }; }
  };
  return { root, grant: { ...selected, descriptor, descriptorDigest: executionDescriptorDigest(descriptor) }, authority,
    runner: new ExecutorRunner(), signal: new AbortController().signal };
}
it("runs verified candidate bytes with bounded Docker resources and cleans up before returning evidence", async () => {
  const options = await input(), completed = await sysboxBackend.run(options);
  expect(completed.result).toBe("success"); expect(completed.stdout.sha256).toBe(`sha256:${hash("executor-output\n")}`);
  const launched = options.runner.calls.find(({ args }) => args[0] === "run")!.args;
  expect(launched).toContain("sysbox-runc"); expect(launched).toContain("--memory");
  expect(options.runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["container", "rm", "--force"]);
});
it("bounds captured output and reports failure after cleanup", async () => {
  const options = await input(); options.runner.output = "x".repeat(2048);
  const completed = await sysboxBackend.run(options);
  expect(completed.completion.kind).toBe("output-limit-exceeded"); expect(completed.stdout.truncated).toBe(true);
  expect(completed.result).toBe("failure"); expect(completed.cleanupComplete).toBe(true);
});
it("fences resources with foreign labels instead of deleting or reporting cleanup complete", async () => {
  const options = await input(); options.runner.foreignOwnership = true;
  await expect(sysboxBackend.run(options)).rejects.toThrow("cleanup is uncertain");
  expect(options.runner.calls.some(({ args }) => args[0] === "container" && args[1] === "rm")).toBe(false);
});
