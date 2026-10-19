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
  assert.equal(result.exitCode, 0, `${JSON.stringify(args)}: ${result.stderr}`);
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
  assert.equal(await command(["sh", "-c", "test \"$TMPDIR\" = /mnt/dim-tmp && test \"$(stat -c %a \"$TMPDIR\")\" = 700 && printf retained-temp > \"$TMPDIR/smoke.txt\" && printf temp-ok"]), "temp-ok");
  assert.match(await command(["docker", "buildx", "version"]), /buildx/);
  assert.match(await command(["docker", "compose", "version"]), /Compose/);
  await command(["dim-workspace", "session", "register", "--", "sh", "-c", "printf 'resumed\\n' >> /home/dim/session-smoke.txt"]);
  await command(["dim-workspace", "service", "register", "--name", "smoke", "--", "sh", "-c", "printf 'started\\n' >> /home/dim/service-smoke.txt; exec sleep infinity"]);
  await command(["dim-workspace", "service", "resume"]);
  await command(["sh", "-c", "ssh-keygen -q -t ed25519 -N '' -f /home/dim/ssh-smoke && dim-workspace-ssh setup /home/dim/ssh-smoke.pub"]);
  const hostKey = await command(["dim-workspace-ssh", "host-key"]);
  const ssh = ["ssh", "-p", "2222", "-i", "/home/dim/ssh-smoke", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "dim@127.0.0.1", "printf ssh-ok"];
  assert.equal(await command(ssh), "ssh-ok");
  await assert.rejects(runtime.seed(record, join(root, "checkout")), /already populated/);
  console.log("source seed and user data preservation: passed");

  // Build and run without contacting a registry: the workspace's Alpine busybox
  // and musl loader form a tiny image for its own nested Docker engine.
  assert.equal(await command(["sh", "-c", "tar -c /bin/busybox /lib/ld-musl-* | docker import - dim-runtime-smoke >/dev/null && docker run --rm dim-runtime-smoke /bin/busybox echo nested-ok"]), "nested-ok");
  console.log("nested container execution: passed");
  await command(["sh", "-c", "for i in $(seq 1 12); do docker run --rm dim-runtime-smoke /bin/busybox true || exit; done; sleep 1; ps -eo stat,comm | awk '$1 ~ /^Z/ && $2 ~ /rootlesskit|containerd-shim/ { bad=1; print } END { exit bad }'"]);
  console.log("repeated nested container exits leave no rootlesskit/containerd-shim zombies: passed");
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
  const resumedBeforeRestart = Number(await command(["sh", "-c", "wc -l < /home/dim/session-smoke.txt"]));
  const servicesBeforeRestart = Number(await command(["sh", "-c", "wc -l < /home/dim/service-smoke.txt"]));
  await runtime.stop(record);
  await assert.rejects(runtime.run(record, ["true"]), /stopped/);
  await runtime.start(record);
  assert.equal(await command(ssh), "ssh-ok");
  assert.equal(await command(["cat", "local.txt"]), "retained checkout");
  await command(["sh", "-c", `for i in $(seq 1 100); do test "$(wc -l < /home/dim/session-smoke.txt)" -gt ${resumedBeforeRestart} && test "$(wc -l < /home/dim/service-smoke.txt)" -gt ${servicesBeforeRestart} && exit 0; sleep .1; done; exit 1`]);
  const resumedBeforeRecreate = Number(await command(["sh", "-c", "wc -l < /home/dim/session-smoke.txt"]));
  const servicesBeforeRecreate = Number(await command(["sh", "-c", "wc -l < /home/dim/service-smoke.txt"]));
  await runtime.remove(record, { keepData: true });
  assert.equal(await runtime.inspect(record), undefined);
  await runtime.create(record);
  await runtime.start(record);
  assert.equal(await command(ssh), "ssh-ok");
  assert.equal(await command(["cat", "local.txt"]), "retained checkout");
  assert.equal(await command(["cat", "/home/dim/smoke.txt"]), "retained home");
  assert.equal(await command(["cat", "/mnt/dim-tmp/smoke.txt"]), "retained-temp");
  assert.equal(await command(["dim-workspace-ssh", "host-key"]), hostKey);
  await command(["sh", "-c", `for i in $(seq 1 100); do test "$(wc -l < /home/dim/session-smoke.txt)" -gt ${resumedBeforeRecreate} && test "$(wc -l < /home/dim/service-smoke.txt)" -gt ${servicesBeforeRecreate} && exit 0; sleep .1; done; exit 1`]);
  assert.match(await command(["dim-workspace", "service", "list"]), /"running":true/);
  console.log("private TMPDIR, SSH identity, registered services and sessions survive restart/recreation: passed");
  assert.equal(await command(["docker", "run", "--rm", "dim-runtime-smoke", "/bin/busybox", "echo", "nested-retained"]), "nested-retained");
  console.log("stop/start and runtime recreation retain checkout, home and nested Docker: passed");
  await runtime.remove(record, { keepData: true });
  const missing = workspaceRuntimeResources(record).checkout;
  const removed = await runner.run("docker", ["volume", "rm", missing]);
  assert.equal(removed.exitCode, 0, removed.stderr);
  await assert.rejects(runtime.create(record), /retained checkout storage is missing/);
  assert.notEqual((await runner.run("docker", ["volume", "inspect", missing])).exitCode, 0);
  console.log("missing retained checkout is rejected without fabricating empty storage: passed");
} catch (error) {
  const diagnostics = await runtime.run(record, ["sh", "-c", "cat /home/dim/session-smoke.txt /home/dim/service-smoke.txt /home/dim/.local/state/dim/session.log /home/dim/.local/state/dim/services/smoke.log 2>&1; dim-workspace service list"]);
  process.stderr.write(diagnostics.stdout + diagnostics.stderr);
  const logs = await runner.run("docker", ["logs", workspaceRuntimeResources(record).container]);
  process.stderr.write(logs.stdout + logs.stderr);
  throw error;
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
