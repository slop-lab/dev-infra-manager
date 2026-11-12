import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { NativeOutputCollector } from "../../../../packages/host/plugins/execution-worker/src/output.js";
import { captureExecutionArtifacts } from "../../../../packages/host/plugins/execution-worker/src/artifacts.js";

export const captureScenarios = ["readable", "unreadable-file", "unreadable-directory", "hardlink", "missing-empty", "missing-nonempty", "unreadable-stderr", "unlisted-errno"] as const;

async function main(): Promise<void> {
  const condition = z.enum(captureScenarios).parse(process.argv[2]);
  // Drop only this disposable child after imports, never the test runner or host.
  if (process.getuid?.() === 0) { process.setgroups?.([]); process.setgid?.(65534); process.setuid?.(65534); }
  assert.notEqual(process.getuid?.(), 0);
  const base = await mkdtemp(join(tmpdir(), "dim-capture-fixture-"));
  const root = condition === "unlisted-errno" ? join(base, "private-path-".repeat(30)) : join(base, "runtime");
  const pending = join(base, "pending"), directory = join(root, "workspace/.dim-ci-artifacts"), source = join(directory, "private-name.json");
  const fileScenario = condition === "readable" || condition === "unreadable-file" || condition === "unreadable-directory" || condition === "hardlink";
  const bytes = Buffer.from('{"status":"PASS"}\n');
  try {
    // Given: real permission/link failures, missing spools, or private readable bytes.
    if (condition !== "unlisted-errno") await mkdir(root);
    if (fileScenario) {
      await mkdir(directory, { recursive: true }); await writeFile(source, bytes, { mode: 0o600 });
      if (condition === "unreadable-file") await chmod(source, 0);
      if (condition === "unreadable-directory") await chmod(directory, 0);
      if (condition === "hardlink") await link(source, join(base, "second-link"));
    }
    const collector = new NativeOutputCollector(100, () => {}, fileScenario || condition === "unreadable-stderr" ? join(root, "output") : undefined);
    if (condition === "missing-nonempty" || condition === "unreadable-stderr") collector.stdout.write("retained stdout");
    const output = collector.result();
    if (condition === "unreadable-stderr") await chmod(join(root, "output/stderr"), 0);
    // When: production capture runs after all fixture writers have stopped.
    const manifest = await captureExecutionArtifacts({ root, pending, result: {
      executionId: randomUUID(), descriptorDigest: "sha256:" + "a".repeat(64), cleanupComplete: true,
      startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), completion: { kind: "exited", exitCode: 0 }, result: "success",
      stdout: output.stdoutEvidence, stderr: output.stderrEvidence,
      logs: { stdout: { base64: output.stdout.toString("base64"), truncated: false }, stderr: { base64: "", truncated: false } }
    } });
    // Then: verify persisted integrity, closed diagnostics and unchanged source permissions.
    const expected = {
      readable: undefined, "unreadable-file": "artifact-capture-failed:source-open:EACCES",
      "unreadable-directory": "artifact-capture-failed:directory-open:EACCES", hardlink: "artifact-capture-failed:file-validation:rejected",
      "missing-empty": undefined, "missing-nonempty": "artifact-capture-failed:source-open:ENOENT",
      "unreadable-stderr": "artifact-capture-failed:source-open:EACCES", "unlisted-errno": "artifact-capture-failed:source-open:unknown"
    }[condition];
    assert.equal(manifest.error, expected); assert.equal(manifest.availability, expected ? "unavailable" : "complete");
    assert.deepEqual(JSON.parse(await readFile(join(pending, "manifest.json"), "utf8")), manifest);
    const names = fileScenario || condition === "missing-empty" ? ["logs/stdout.log", "logs/stderr.log"] : condition === "unreadable-stderr" ? ["logs/stdout.log"] : [];
    assert.deepEqual(manifest.artifacts.map(x => x.name), condition === "readable" ? [...names, "files/private-name.json"] : names);
    for (const artifact of manifest.artifacts) {
      const retained = await readFile(join(pending, artifact.id));
      assert.equal(retained.length, artifact.bytes); assert.equal("sha256:" + createHash("sha256").update(retained).digest("hex"), artifact.sha256);
      assert.deepEqual(retained, artifact.name.startsWith("files/") ? bytes : artifact.name === "logs/stdout.log" ? output.stdout : output.stderr);
      assert.equal((await lstat(join(pending, artifact.id))).mode & 0o777, 0o600);
    }
    if (condition === "readable") assert.equal((await lstat(source)).mode & 0o777, 0o600);
    if (condition === "unreadable-file") assert.equal((await lstat(source)).mode & 0o777, 0);
    if (condition === "unreadable-directory") assert.equal((await lstat(directory)).mode & 0o777, 0);
    if (condition === "hardlink") assert.equal((await lstat(source)).nlink, 2);
    if (condition === "unreadable-stderr") assert.equal((await lstat(join(root, "output/stderr"))).mode & 0o777, 0);
  } finally {
    if (fileScenario) await chmod(directory, 0o700);
    await rm(base, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({ condition, verified: true }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
