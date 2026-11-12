import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { sysboxBackend } from "../../../../packages/host/plugins/execution-worker/src/backends/sysbox.js";
import { captureExecutionArtifacts } from "../../../../packages/host/plugins/execution-worker/src/artifacts.js";
import { assignment, grant } from "../../../contracts/ci/executionFixture.js";
import { ExecutorRunner } from "./sysboxFixture.js";
import { artifactTar } from "./artifactTarFixture.js";
import { containerArtifactFixture } from "./containerArtifactFixture.js";
import { artifactArchivePath, artifactArchiveLimit, indexArtifactFiles } from "../../../../packages/host/plugins/execution-worker/src/artifact-source.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const selected = await containerArtifactFixture(); roots.push(selected.root); return selected; }

it("captures 0600 nonce bytes through the stopped backend handoff when the original host file is unreadable after removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-container-handoff-"));
  const directory = join(root, "workspace/.dim-ci-artifacts"), path = join(directory, "private.json");
  try {
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ nonce: "fffccb07-6199-4772-b225-0556b8b61166" }) + "\n");
    await writeFile(path, bytes, { mode: 0o600 });
    const runner = new ExecutorRunner(); runner.archive = artifactTar("private.json", bytes);
    runner.afterRemoval = () => chmod(path, 0);
    const completed = await sysboxBackend.run({ root, runner, grant: grant(assignment()), signal: new AbortController().signal,
      acquireCandidate: async ({ scriptFile }) => { await writeFile(scriptFile, "true\n"); } });
    if (completed.artifactSource === undefined) throw new Error("backend artifact handoff missing");
    const manifest = await captureExecutionArtifacts({ root, pending: join(root, "pending"), result: completed, artifactSource: completed.artifactSource, artifactNonce: completed.artifactSource.nonce });
    expect(manifest.availability).toBe("complete");
    const artifact = manifest.artifacts.find(item => item.name === "files/private.json"); expect(artifact).toBeDefined();
    if (artifact === undefined) throw new Error("nonce artifact missing");
    expect(await readFile(join(root, "pending", artifact.id))).toEqual(bytes);
    expect(artifact.sha256).toBe("sha256:" + createHash("sha256").update(bytes).digest("hex"));
    expect((await lstat(path)).mode & 0o777).toBe(0);
    const commands = runner.calls.map(call => call.args[0]);
    expect(commands.indexOf("stop")).toBeLessThan(commands.indexOf("cp"));
    expect(commands.indexOf("cp")).toBeLessThan(commands.indexOf("container", commands.indexOf("cp")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["stop", "running", "copy-exit", "copy-throw", "stdout-bound", "stderr-bound", "changed"] as const)("keeps command success separate from %s handoff failure and removes the exact runtime", async condition => {
  const f = await fixture();
  if (condition === "stop") f.runner.stopExitCode = 1;
  if (condition === "running") f.runner.runningAfterStop = true;
  if (condition === "copy-exit") f.runner.copyExitCode = 1;
  if (condition === "copy-throw") f.runner.copyThrows = true;
  if (condition === "stdout-bound") f.runner.archive = Buffer.alloc(artifactArchiveLimit(await indexArtifactFiles(f.root)) + 512);
  if (condition === "stderr-bound") f.runner.copyStderr = Buffer.alloc(4097);
  if (condition === "changed") f.runner.onCopy = () => writeFile(f.path, "changed");
  const { completed, manifest } = await f.capture();
  expect(completed.result).toBe("success"); expect(manifest.availability).toBe("unavailable");
  expect(manifest.artifacts.map(entry => entry.name)).toEqual(["logs/stdout.log", "logs/stderr.log"]);
  expect(manifest.error).not.toContain("private export failure detail");
  expect(f.runner.calls.at(-1)?.args).toEqual(["container", "rm", "--force", "--volumes", "c".repeat(64)]);
  await expect(lstat(artifactArchivePath(f.root, f.nonce))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["hardlink", "root-symlink", "ancestor-symlink", "fifo", "file-size", "total-size", "depth", "entries"] as const)("rejects %s source metadata before requesting archive bytes", async condition => {
  const f = await fixture();
  if (condition === "hardlink") await link(f.path, join(f.root, "outside-link"));
  if (condition === "root-symlink") { await rm(f.directory, { recursive: true }); await symlink(f.root, f.directory); }
  if (condition === "ancestor-symlink") { await rm(join(f.root, "workspace"), { recursive: true }); await symlink(f.root, join(f.root, "workspace")); }
  if (condition === "fifo") { await rm(f.path); await promisify(execFile)("mkfifo", [f.path]); }
  if (condition === "file-size") await truncate(f.path, 128 * 1024 * 1024 + 1);
  if (condition === "total-size") for (let i = 0; i < 3; i++) { const path = join(f.directory, "large-" + i); await writeFile(path, ""); await truncate(path, 100 * 1024 * 1024); }
  if (condition === "depth") await mkdir(join(f.directory, ...Array.from({ length: 18 }, () => "nested")), { recursive: true });
  if (condition === "entries") await Promise.all(Array.from({ length: 513 }, (_, index) => mkdir(join(f.directory, "directory-" + index))));
  const { manifest } = await f.capture();
  expect(manifest.error).toBe("artifact-capture-failed:artifact-metadata-rejected");
  expect(f.runner.calls.some(call => call.args[0] === "cp")).toBe(false);
  expect(f.runner.calls.at(-1)?.args.slice(0, 2)).toEqual(["container", "rm"]);
});
it.each(["foreign-labels", "replaced-id", "removal"] as const)("fences %s instead of returning a cleaned result", async condition => {
  const f = await fixture();
  if (condition === "foreign-labels") f.runner.foreignOwnership = true;
  if (condition === "replaced-id") f.runner.inspectedId = "d".repeat(64);
  if (condition === "removal") f.runner.failRemoval = true;
  await expect(f.run()).rejects.toThrow("cleanup is uncertain");
  if (condition !== "removal") expect(f.runner.calls.some(call => call.args[0] === "stop" || call.args[0] === "cp" || call.args[1] === "rm")).toBe(false);
});
it("rejects a handoff from another attempt nonce while retaining both logs", async () => {
  const f = await fixture(), { manifest } = await f.capture("00000000-0000-4000-8000-000000000000");
  expect(manifest.availability).toBe("unavailable"); expect(manifest.artifacts).toHaveLength(2);
  expect(await readdir(join(f.root, "pending"))).toHaveLength(3);
});
it("marks files unavailable after a lost launch response instead of claiming an empty successful export", async () => {
  const f = await fixture(); f.runner.launchResponseLost = true;
  const { completed, manifest } = await f.capture();
  expect(completed.completion).toEqual({ kind: "executor-failure", code: "container-launch-failed" });
  expect(manifest.error).toBe("artifact-capture-failed:artifact-export-failed"); expect(manifest.artifacts).toHaveLength(2);
  expect(f.runner.calls.some(call => call.args[0] === "cp")).toBe(false);
  expect(f.runner.calls.at(-1)?.args).toEqual(["container", "rm", "--force", "--volumes", "c".repeat(64)]);
});
