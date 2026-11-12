import assert from "node:assert/strict";
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ProcessRunner } from "../../../../packages/host/core/src/runner.js";
import type { RunOptions } from "../../../../packages/host/core/src/types.js";
import { ExecutorRunner } from "./sysboxFixture.js";
import { containerArtifactFixture } from "./containerArtifactFixture.js";
import { artifactTar } from "./artifactTarFixture.js";
import { artifactArchivePath } from "../../../../packages/host/plugins/execution-worker/src/artifact-source.js";

class ArchiveProcessFixture extends ExecutorRunner {
  workspace = "";
  hold = false;
  lastExit: number | undefined;
  override async runStreaming(command: string, args: string[], options?: RunOptions): Promise<number> {
    if (args[0] !== "cp") return super.runStreaming(command, args, options);
    assert.equal(command, "docker"); assert.deepEqual(args, ["cp", "c".repeat(64) + ":/workspace/.dim-ci-artifacts", "-"]);
    this.calls.push({ command, args: [...args] });
    this.lastExit = await new ProcessRunner().runStreaming(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--conditions=dim-source", fileURLToPath(import.meta.url), "--produce", this.workspace, ...(this.hold ? ["--hold"] : [])],
      { ...options, ...(this.hold ? { signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(100)]) } : {}) });
    return this.lastExit;
  }
}
async function produce(): Promise<void> {
  const workspace = process.argv[3]; if (workspace === undefined) throw new Error("fixture workspace missing");
  if (process.argv[4] === "--hold") await new Promise<void>(() => { setInterval(() => {}, 1000); });
  const archive = artifactTar("private.json", await readFile(join(workspace, ".dim-ci-artifacts/private.json")));
  let drains = 0;
  for (let offset = 0; offset < archive.length; offset += 4096) {
    if (!process.stdout.write(archive.subarray(offset, offset + 4096))) { drains++; await once(process.stdout, "drain"); }
  }
  process.stdout.end(); await finished(process.stdout);
  await writeFile(join(workspace, "producer-progress.json"), JSON.stringify({ drains }), { flag: "wx", mode: 0o600 });
}
async function drive(): Promise<void> {
const runner = new ArchiveProcessFixture(), f = await containerArtifactFixture(runner);
try {
  runner.workspace = join(f.root, "workspace");
  const bytes = Buffer.from(JSON.stringify({ nonce: "fffccb07-6199-4772-b225-0556b8b61166", payload: "x".repeat(200000) }) + "\n");
  await writeFile(f.path, bytes, { mode: 0o600 }); runner.afterRemoval = () => chmod(f.path, 0);
  const { completed, manifest } = await f.capture();
  assert.equal(completed.result, "success"); assert.equal(manifest.availability, "complete", manifest.error);
  assert.equal(manifest.artifacts.length, 3);
  for (const artifact of manifest.artifacts) {
    const stored = await readFile(join(f.root, "pending", artifact.id));
    assert.equal(stored.length, artifact.bytes); assert.equal("sha256:" + createHash("sha256").update(stored).digest("hex"), artifact.sha256);
    if (artifact.name === "files/private.json") assert.deepEqual(stored, bytes);
    assert.equal((await lstat(join(f.root, "pending", artifact.id))).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(f.path)).mode & 0o777, 0);
  const stop = runner.calls.findIndex(call => call.args[0] === "stop"), cp = runner.calls.findIndex(call => call.args[0] === "cp"), remove = runner.calls.findIndex(call => call.args[1] === "rm");
  assert.ok(stop >= 0 && stop < cp && cp < remove);
  assert.equal(runner.lastExit, 0);
  const archive = await readFile(artifactArchivePath(f.root, f.nonce));
  const progress: unknown = JSON.parse(await readFile(join(runner.workspace, "producer-progress.json"), "utf8"));
  process.stdout.write(JSON.stringify({ node: process.version, nonce: "fffccb07-6199-4772-b225-0556b8b61166", actualSubprocess: "node-chunked-archive-producer", dockerRuntime: "not-used", verifiedArtifacts: manifest.artifacts.length, privateBytes: bytes.length, archiveBytes: archive.length, archiveSha256: createHash("sha256").update(archive).digest("hex"), progress, sourceModeUnchangedAfterRemoval: true }) + "\n");
} finally { await rm(f.root, { recursive: true, force: true }); }
const cancelledRunner = new ArchiveProcessFixture(), cancelled = await containerArtifactFixture(cancelledRunner);
try {
  cancelledRunner.workspace = join(cancelled.root, "workspace"); cancelledRunner.hold = true;
  const { completed, manifest } = await cancelled.capture();
  assert.equal(completed.result, "success"); assert.equal(manifest.availability, "unavailable"); assert.equal(manifest.artifacts.length, 2);
  assert.notEqual(cancelledRunner.lastExit, 0);
  await assert.rejects(lstat(artifactArchivePath(cancelled.root, cancelled.nonce)), { code: "ENOENT" });
  assert.equal(cancelledRunner.calls.at(-1)?.args[1], "rm");
  process.stdout.write(JSON.stringify({ node: process.version, scenario: "producer-cancelled", producerExit: cancelledRunner.lastExit, retainedLogs: manifest.artifacts.length, archiveRemoved: true, ownedRuntimeCleanupAttempted: true }) + "\n");
} finally { await rm(cancelled.root, { recursive: true, force: true }); }
}
if (process.argv[2] === "--produce") await produce(); else await drive();
