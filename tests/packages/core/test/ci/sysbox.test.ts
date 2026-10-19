import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSysboxBackend, sysboxBackend } from "../../../../../core/packages/managed/src/ci/backends/sysbox.js";
import { executionDescriptorDigest } from "../../../../../core/packages/native-git/src/execution-protocol.js";
import type { NativeCandidateReadAuthority } from "../../../../../core/packages/managed/src/ci/candidate.js";
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
  expect(launched[launched.indexOf("--oom-score-adj") + 1]).toBe("500");
  expect(launched).toContain("sysbox-runc"); expect(launched).toContain("--memory");
  expect(options.runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["container", "rm", "--force"]);
});
it("bounds captured output and reports failure after cleanup", async () => {
  const options = await input(); options.runner.output = "x".repeat(2048);
  const completed = await sysboxBackend.run(options);
  expect(completed.completion.kind).toBe("output-limit-exceeded"); expect(completed.stdout.truncated).toBe(true);
  expect(completed.result).toBe("failure"); expect(completed.cleanupComplete).toBe(true);
});
it("delivers host plugin configuration read-only to networked jobs without placing package-manager policy in the backend", async () => {
  const options = await input(), contents = "Acquire::http::Proxy \"http://172.18.0.3:3142\";\n";
  options.runner.beforeLaunch = async (args) => {
    expect(await readFile(join(options.root, "config-0"), "utf8")).toBe(contents);
    expect((await stat(join(options.root, "config-0"))).mode & 0o777).toBe(0o400);
    expect(args).toContain(`type=bind,source=${join(options.root, "config-0")},target=/run/dim/job/config-0,readonly`);
    const launcher = await readFile(join(options.root, "runner.bash"), "utf8");
    expect(launcher).toContain("--network bridge");
    expect(launcher).toContain("--workdir /workspace/root");
    expect(launcher).toContain("source=/run/dim/job/config-0,target=/etc/apt/apt.conf.d/99dim-mirrors,readonly");
    expect(launcher).not.toContain("HTTP_PROXY");
    expect(launcher).toContain("NPM_CONFIG_GLOBALCONFIG");
    expect(launcher).toContain("/etc/npmrc");
  };
  const backend = createSysboxBackend({ network: "cache-network", blockedHostnames: [], dockerDaemonConfig: "{}\n",
    jobFiles: [{ target: "/etc/apt/apt.conf.d/99dim-mirrors", contents }],
    jobEnvironmentDefaults: { NPM_CONFIG_GLOBALCONFIG: "/etc/npmrc" } });
  expect((await backend.run(options)).result).toBe("success");
});
it("fences resources with foreign labels instead of deleting or reporting cleanup complete", async () => {
  const options = await input(); options.runner.foreignOwnership = true;
  await expect(sysboxBackend.run(options)).rejects.toThrow("cleanup is uncertain");
  expect(options.runner.calls.some(({ args }) => args[0] === "container" && args[1] === "rm")).toBe(false);
});
