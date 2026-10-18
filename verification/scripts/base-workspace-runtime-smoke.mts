#!/usr/bin/env -S tsx
/** Explicit live verification: pass an already built DIM workspace image as argv[2]. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner } from "../../core/packages/core/src/runner.js";
import type { WorkspaceRecord } from "../../core/packages/core/src/workspace/models.js";
import { ContainerWorkspaceRuntime, workspaceRuntimeResources } from "../../core/packages/core/src/workspace/runtime.js";
import { acquireWorkspaceSource } from "../../core/packages/core/src/workspace/source.js";

const image = process.argv[2];
if (image === undefined) throw new Error("usage: tsx base-workspace-runtime-smoke.mts IMAGE");
const root = await mkdtemp(join(tmpdir(), "dim-base-runtime-smoke-"));
const runner = new ProcessRunner();
const runtime = new ContainerWorkspaceRuntime(runner);
const id = randomUUID();
const repository = join(root, "source");
await mkdir(repository);
async function git(args: string[]) {
  const result = await runner.run("git", ["-C", repository, ...args]);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
await git(["init", "--initial-branch=main"]);
await writeFile(join(repository, "hello.txt"), "source checkout\n");
await git(["add", "."]);
await git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "source"]);
const source = await acquireWorkspaceSource({ source: { url: repository }, destination: join(root, "checkout") });
const record: WorkspaceRecord = {
  schemaVersion: 10, id, name: `runtime-smoke-${id.slice(0, 8)}`, source, runtime: "container", image,
  resources: { cpuCount: "1", memory: "2g", pidsLimit: "512" },
  git: { name: "Smoke", email: "smoke@example.invalid" }, initialized: false,
  phase: "creating", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
};
async function command(args: string[]) {
  const result = await runtime.run(record, args, { signal: AbortSignal.timeout(60_000) });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
try {
  await runtime.create(record);
  assert.equal((await runtime.inspect(record))?.running, false);
  await runtime.start(record);
  await runtime.seed(record, join(root, "checkout"));
  record.initialized = true;
  assert.equal(await command(["git", "rev-parse", "HEAD"]), source.commit);
  assert.equal(await command(["cat", "hello.txt"]), "source checkout");
  assert.equal(await command(["id", "-u"]), String(process.getuid?.()));
  assert.match(await command(["git", "var", "GIT_AUTHOR_IDENT"]), /^Smoke <smoke@example\.invalid> \d+ [+-]\d{4}$/);
  assert.equal(await command(["git", "config", "user.email"]), record.git.email);
  await command(["sh", "-c", "printf 'retained checkout' > local.txt; printf 'retained home' > /home/dim/smoke.txt"]);
  await assert.rejects(runtime.seed(record, join(root, "checkout")), /already populated/);
  console.log("source seed and user data preservation: passed");

  // Build and run without contacting a registry: the workspace's Alpine busybox
  // and musl loader form a tiny image for its own nested Docker engine.
  assert.equal(await command(["sh", "-c", "tar -c /bin/busybox /lib/ld-musl-* | docker import - dim-runtime-smoke >/dev/null && docker run --rm dim-runtime-smoke /bin/busybox echo nested-ok"]), "nested-ok");
  console.log("nested container execution: passed");
  const original = record.resources;
  const limited = { cpuCount: "0.5", memory: "1g", pidsLimit: "256" };
  assert.deepEqual(await runtime.updateResources(record, limited), { recreated: false });
  record.resources = limited;
  const unlimited = { cpuCount: "unlimited", memory: "unlimited", pidsLimit: "unlimited" };
  assert.deepEqual(await runtime.updateResources(record, unlimited), { recreated: true });
  record.resources = unlimited;
  await runtime.updateResources(record, original);
  record.resources = original;
  console.log("live budget updates and unlimited reset by data-preserving recreation: passed");
  await runtime.stop(record);
  await assert.rejects(runtime.run(record, ["true"]), /stopped/);
  await runtime.start(record);
  assert.equal(await command(["cat", "local.txt"]), "retained checkout");
  await runtime.remove(record, { keepData: true });
  assert.equal(await runtime.inspect(record), undefined);
  await runtime.create(record);
  await runtime.start(record);
  assert.equal(await command(["cat", "local.txt"]), "retained checkout");
  assert.equal(await command(["cat", "/home/dim/smoke.txt"]), "retained home");
  assert.equal(await command(["docker", "run", "--rm", "dim-runtime-smoke", "/bin/busybox", "echo", "nested-retained"]), "nested-retained");
  console.log("stop/start and runtime recreation retain checkout, home and nested Docker: passed");
  await runtime.remove(record, { keepData: true });
  const missing = workspaceRuntimeResources(record).checkout;
  const removed = await runner.run("docker", ["volume", "rm", missing]);
  assert.equal(removed.exitCode, 0, removed.stderr);
  await assert.rejects(runtime.create(record), /retained checkout storage is missing/);
  assert.notEqual((await runner.run("docker", ["volume", "inspect", missing])).exitCode, 0);
  console.log("missing retained checkout is rejected without fabricating empty storage: passed");
} finally {
  await runtime.remove(record, { keepData: false });
  const resources = workspaceRuntimeResources(record);
  for (const [role, name] of Object.entries(resources)) {
    const kind = role === "container" || role === "network" ? role : "volume";
    const result = await runner.run("docker", [kind, "inspect", name]);
    assert.notEqual(result.exitCode, 0, `${kind} ${name} survived discard`);
  }
  await rm(root, { recursive: true, force: true });
}
console.log("owned runtime and storage discard: passed");
