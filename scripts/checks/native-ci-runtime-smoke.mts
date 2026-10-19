#!/usr/bin/env -S tsx
/** Explicit live CI gate: pass a runtime, supervisor and reviewed Ubuntu image digest. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner } from "../../packages/host/core/src/runner.js";
import { nativeRunnerScript } from "../../packages/host/plugins/ci-worker/src/backends/containers.js";

const [runtime, supervisor, image] = process.argv.slice(2);
if (!["container", "vm"].includes(runtime ?? "") || !supervisor || !image || !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("usage: tsx native-ci-runtime-smoke.mts container|vm SUPERVISOR_IMAGE UBUNTU_IMAGE@sha256:DIGEST");
const root = await mkdtemp(join(tmpdir(), "dim-ci-live-")), job = join(root, "job"), workspace = join(root, "workspace");
const name = `dim-ci-live-${randomUUID()}`, runner = new ProcessRunner();
const uid = process.getuid?.(), gid = process.getgid?.(), kvm = runtime === "vm" ? await stat("/dev/kvm") : undefined;
if (uid === undefined || gid === undefined || kvm && !kvm.isCharacterDevice()) throw new Error("Linux/KVM is required");
try {
  await mkdir(job, { mode: 0o755 }); await mkdir(workspace); await mkdir(join(workspace, "fixture"));
  await writeFile(join(job, "descriptor.json"), "{}\n", { mode: 0o444 });
  await writeFile(join(job, "config-0"), "read-only host plugin configuration\n", { mode: 0o444 });
  await writeFile(join(job, "working-directory"), "/workspace/fixture", { mode: 0o444 });
  await writeFile(join(job, "job-environment"), "", { mode: 0o444 });
  await writeFile(join(job, "config-targets"), "config-0 /etc/dim-ci-smoke.conf\n", { mode: 0o444 });
  if (runtime === "vm") {
  const prepared = await runner.run("docker", ["create", "--name", `${name}-rootfs`, "--label", `dim.verification=${name}`, "--network", "none", "--read-only", "--entrypoint", "/bin/bash", image]);
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  const archive = await runner.run("docker", ["export", "--output", join(job, "rootfs.tar"), prepared.stdout.trim()]);
  assert.equal(archive.exitCode, 0, archive.stderr);
  }
  await writeFile(join(job, "runner"), nativeRunnerScript("fixture", ["/etc/dim-ci-smoke.conf"]), { mode: 0o444 });
  await writeFile(join(job, "daemon.json"), "{}\n", { mode: 0o444 });
  await writeFile(join(job, "script"), `set -euo pipefail
test "$(id -u)" = 0
${runtime === "vm" ? `test "$(cat /sys/fs/cgroup/dim-job/pids.max)" = 256
if printf max >/proc/1/root/sys/fs/cgroup/dim-job/pids.max 2>/dev/null; then exit 1; fi
if mount -o remount,rw /sys/fs/cgroup 2>/dev/null; then exit 1; fi` : ""}
grep -q 'read-only host plugin configuration' /etc/dim-ci-smoke.conf
if printf overwritten >/etc/dim-ci-smoke.conf 2>/dev/null; then exit 1; fi
mkdir -p /usr/local/share/dim-smoke
printf writable >/usr/local/share/dim-smoke/rootfs
getent hosts archive.ubuntu.com
if ! apt-get update -o Acquire::Retries=0 -o Acquire::http::Timeout=20 >/tmp/apt-update.log 2>&1; then cat /tmp/apt-update.log; exit 1; fi
if ! apt-get install -y --no-install-recommends hello >/tmp/apt-install.log 2>&1; then cat /tmp/apt-install.log; exit 1; fi
hello
printf retained >/workspace/ci-result
`, { mode: 0o444 });
  const specific = kvm ? ["--read-only", "--user", `${uid}:${gid}`, "--group-add", String(kvm.gid), "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--device", "/dev/kvm:/dev/kvm", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--mount", `type=bind,src=${workspace},dst=/run/dim/workspace`, supervisor, "/usr/local/bin/dim-native-qemu-run",
    "/run/dim/job/descriptor.json", "/run/dim/job/script", "/run/dim/workspace", image, "2", "1073741824", "256"]
    : ["--runtime", "sysbox-runc", "--env", "DOCKER_TLS_CERTDIR=", "--env", `DIM_JOB_IMAGE=${image}`, "--env", "DIM_JOB_CPUS=1", "--env", "DIM_JOB_MEMORY=1073741824", "--env", "DIM_JOB_PIDS=256",
      "--mount", `type=bind,src=${workspace},dst=/workspace`, "--mount", `type=bind,src=${join(job, "daemon.json")},dst=/etc/docker/daemon.json,readonly`,
      "--entrypoint", "/bin/sh", supervisor, "/run/dim/job/runner"];
  const result = await runner.run("docker", ["run", "--rm", "--init", "--name", name, "--label", `dim.verification=${name}`, "--network", "bridge",
    "--cpus", "2", "--memory", "1536m", "--pids-limit", "512", "--oom-score-adj", "500",
    "--mount", `type=bind,src=${job},dst=/run/dim/job,readonly`, ...specific], { signal: AbortSignal.timeout(180_000) });
  process.stdout.write(result.stdout + result.stderr);
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(join(workspace, "ci-result"), "utf8"), "retained");
  console.log(`actual ${runtime} CI: ordinary Ubuntu image, DNS/egress, apt install, readonly plugin configuration and output workspace: passed`);
} finally {
  for (const container of [name, `${name}-rootfs`]) {
  const inspected = await runner.run("docker", ["container", "inspect", container, "--format", '{{.Id}}|{{index .Config.Labels "dim.verification"}}']);
  if (inspected.exitCode === 0) {
    const [id, owner] = inspected.stdout.trim().split("|");
    if (owner !== name || !id || !/^[0-9a-f]{64}$/.test(id)) throw new Error("preserving unexpected QEMU verification container");
    const removed = await runner.run("docker", ["container", "rm", "--force", "--volumes", id]);
    assert.equal(removed.exitCode, 0, removed.stderr);
  }
  }
  await rm(root, { recursive: true, force: true });
}
