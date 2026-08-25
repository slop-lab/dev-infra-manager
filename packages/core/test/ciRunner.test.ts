import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CI_RUNNER_DEFAULTS,
  CI_RUNNER_LABELS,
  ciRunnerContainerArgs,
  ciRunnerContainerName,
  ciRunnerQemuRunnerName,
  ciRunnerQemuCacheVolumeName,
  ciRunnerQemuDispatchVolumeName,
  ciRunnerQemuSupervisorArgs,
  ciRunnerQemuSupervisorName,
  ciRunnerQemuVolumeName,
  detectCiRunnerKvm,
  effectiveCiRunnerResources,
  effectiveQemuCiRunnerResources,
  qemuMemoryMiB
} from "../../../../core/packages/core/src/ciRunner.js";
import { giteaCiRunnerApiBase } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord, LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  QEMU_CI_PACKER_PROVISION_SCRIPT,
  QEMU_CI_PACKER_TEMPLATE,
  QEMU_CI_SUPERVISOR_DOCKERFILE,
  QEMU_CI_SUPERVISOR_SCRIPT,
  QEMU_CI_WEBHOOK_SCRIPT
} from "../../../../core/packages/core/src/qemuCiRunnerAssets.js";
import {
  SYSBOX_CI_RUNNER_BASE_IMAGE,
  SYSBOX_CI_RUNNER_DOCKERFILE,
  SYSBOX_CI_RUNNER_HEALTH_SCRIPT,
  SYSBOX_CI_RUNNER_IMAGE
} from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";

const options = {
  ciRunnerDefaultCpus: BUILTIN_CI_RUNNER_DEFAULTS.cpus,
  ciRunnerDefaultMemory: BUILTIN_CI_RUNNER_DEFAULTS.memory,
  ciRunnerDefaultPidsLimit: BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit
} as LifecycleOptions;

const temporaryDirectories: string[] = [];
const hasPython = spawnSync("python3", ["--version"]).status === 0;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CI runner resources", () => {
  it("uses configured defaults and marks them inherited", () => {
    expect(effectiveCiRunnerResources(options, undefined, {
      cpus: "6",
      memory: "12GiB",
      pidsLimit: "4096"
    })).toEqual({
      resources: { cpus: "6", memory: "12GiB", pidsLimit: "4096" },
      inheritsResources: true
    });
  });

  it("applies project overrides without changing unspecified defaults", () => {
    expect(effectiveCiRunnerResources(options, { memory: "16GiB" }, {
      cpus: "6",
      memory: "12GiB",
      pidsLimit: "4096"
    })).toEqual({
      resources: { cpus: "6", memory: "16GiB", pidsLimit: "4096" },
      inheritsResources: false
    });
  });

  it("maps CPU and memory overrides to QEMU guest resources", () => {
    expect(effectiveQemuCiRunnerResources(options, { cpus: "6", memory: "12GiB" }, {
      cpus: "4", memory: "8g", pidsLimit: "2048"
    })).toEqual({
      resources: { cpus: "6", memory: "12GiB" },
      inheritsResources: false
    });
    expect(qemuMemoryMiB("12GiB")).toBe(12288);
    expect(() => effectiveQemuCiRunnerResources(options, { cpus: "1.5" })).toThrow(/positive integer/);
    expect(() => effectiveQemuCiRunnerResources(options, { pidsLimit: "512" })).toThrow(/sysbox/);
  });

  it("derives stable managed resource names", () => {
    expect(ciRunnerContainerName("example", "fast-1")).toBe("dim-ci-example-fast-1");
    expect(ciRunnerQemuSupervisorName("example", "kvm-1")).toBe("dim-ci-example-kvm-1-qemu-supervisor");
    expect(ciRunnerQemuRunnerName("example", "kvm-1")).toBe("dim-ci-example-kvm-1-qemu");
    expect(ciRunnerQemuDispatchVolumeName("example")).toBe("dim-ci-example-qemu-dispatch");
    expect(ciRunnerQemuCacheVolumeName("example")).toBe("dim-ci-example-qemu-cache");
    expect(ciRunnerQemuVolumeName("example", "kvm-1")).toBe("dim-ci-example-kvm-1-qemu-data");
    expect(() => ciRunnerContainerName("../bad", "fast-1")).toThrow(/project name/);
    expect(() => ciRunnerContainerName("example", "../bad")).toThrow(/CI runner name/);
  });

  it("registers the Project runner at organization scope", () => {
    expect(giteaCiRunnerApiBase({
      gitNamespace: "dim-example"
    })).toBe("/orgs/dim-example/actions/runners");
  });

  it("applies the runner boundary without mounting the host Docker socket", () => {
    const record = { projectName: "example", name: "fast-1" };
    const executor = {
      kind: "sysbox" as const, phase: "ready" as const,
      containerName: "dim-ci-example",
      volumeName: "dim-ci-example-data",
      image: "runner:image",
      runtime: "sysbox-runc",
      resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
      inheritsResources: true, labels: ["dim"], updatedAt: "now"
    };
    const args = ciRunnerContainerArgs(record, executor, { instanceUrl: "http://coordinator", token: "secret" }, true);
    expect(args).toContain("sysbox-runc");
    expect(args).toContain("4");
    expect(args).toContain("8g");
    expect(args).toContain("2048");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(args.join(" ")).toContain("target=/etc/docker/daemon.json,volume-subpath=docker-daemon.json,readonly");
    expect(args.join(" ")).toContain("dim:docker://gitea/runner-images:ubuntu-24.04");
    expect(args.join(" ")).toContain("ubuntu-24.04:docker://gitea/runner-images:ubuntu-24.04");
    expect(args).toContain(`GITEA_RUNNER_LABELS=${CI_RUNNER_LABELS}`);
    expect(CI_RUNNER_LABELS).toContain("dim-container-integration:host");
    expect(CI_RUNNER_LABELS).not.toContain("dim-qemu");
  });

  it("keeps KVM out of the Sysbox runner and configures a trusted QEMU supervisor", async () => {
    await expect(detectCiRunnerKvm(async () => {})).resolves.toBe(true);
    await expect(detectCiRunnerKvm(async () => { throw new Error("missing"); })).resolves.toBe(false);
    await expect(detectCiRunnerKvm(async () => {}, "arm64")).resolves.toBe(false);
    const record = { projectName: "example", name: "kvm-1" };
    const sysbox = { kind: "sysbox" as const, phase: "ready" as const, containerName: "dim-ci-example", volumeName: "dim-ci-example-data", image: "runner:image", runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "now" };
    const qemu = { kind: "qemu" as const, phase: "ready" as const, supervisorName: "dim-ci-example-qemu-supervisor", volumeName: "dim-ci-example-qemu-data", image: "qemu-supervisor:image", resources: { cpus: "6", memory: "12g" }, inheritsResources: false, labels: ["dim-qemu"], updatedAt: "now" };
    const containerArgs = ciRunnerContainerArgs(record, sysbox, undefined, true);
    expect(containerArgs).not.toContain("/dev/kvm");
    expect(containerArgs).toContain(`GITEA_RUNNER_LABELS=${CI_RUNNER_LABELS}`);
    expect(containerArgs).toContain("DIM_CI_REGISTRY_CACHE_UPSTREAM=dim-registry-cache:5000");

    const qemuArgs = ciRunnerQemuSupervisorArgs(
      record,
      qemu,
      { instanceUrl: "http://coordinator", token: "secret" },
      "Bearer webhook-secret",
      () => 108,
      { path: "/state/projects/example/cache.bash", key: "0123456789abcdef" }
    );
    expect(qemuArgs).toEqual(expect.arrayContaining([
      "--runtime", "runc", "--device", "/dev/kvm", "--group-add", "108"
    ]));
    expect(qemuArgs).toContain("GITEA_RUNNER_NAME=dim-ci-example-kvm-1-qemu");
    expect(qemuArgs).toContain("DIM_CI_REGISTRY_CACHE_UPSTREAM=dim-registry-cache:5000");
    expect(qemuArgs).toContain("DIM_QEMU_CI_CAPACITY=kvm-1");
    expect(qemuArgs.join(" ")).toContain("dim-ci-example-qemu-dispatch");
    expect(qemuArgs.join(" ")).toContain("dim-ci-example-qemu-cache");
    expect(qemuArgs.join(" ")).toContain("target=/var/lib/dim-qemu-ci-project/cache.bash,readonly");
    expect(qemuArgs.join(" ")).toContain("source=/state/projects/example/cache.bash");
    expect(qemuArgs).toContain("DIM_QEMU_CI_PROJECT_CACHE_KEY=0123456789abcdef");
    expect(qemuArgs).toContain("DIM_QEMU_CI_CPUS=6");
    expect(qemuArgs).toContain("DIM_QEMU_CI_MEMORY_MB=12288");
    expect(qemuArgs).toContain("DIM_QEMU_WEBHOOK_AUTHORIZATION=Bearer webhook-secret");
    expect(qemuArgs).toEqual(expect.arrayContaining(["--memory", "14336m"]));
    expect(qemuArgs).toContain("qemu-supervisor:image");
  });

  it("ships a pinned, syntactically valid supervisor without putting the registration token in cloud-init", () => {
    expect(QEMU_CI_SUPERVISOR_DOCKERFILE).toMatch(/^FROM ubuntu@sha256:[0-9a-f]{64}$/m);
    expect(spawnSync("bash", ["-n"], { input: QEMU_CI_SUPERVISOR_SCRIPT }).status).toBe(0);
    expect(spawnSync("bash", ["-n"], { input: QEMU_CI_PACKER_PROVISION_SCRIPT }).status).toBe(0);
    expect(QEMU_CI_PACKER_TEMPLATE).toContain('version = "= 1.1.6"');
    expect(QEMU_CI_PACKER_TEMPLATE).toContain('source  = "github.com/hashicorp/qemu"');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('flock 9');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('/var/lib/dim-qemu-ci-cache');
    expect(QEMU_CI_PACKER_TEMPLATE).toContain('variable "project_cache_script_file"');
    expect(QEMU_CI_PACKER_TEMPLATE).toContain('sudo /tmp/dim-project-qemu-cache.bash /var/lib/dim-kvm-cache');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("DIM_QEMU_CI_PROJECT_CACHE_KEY is required");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("DIM_KVM_IMAGE_CACHE=/var/lib/dim-kvm-cache");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('"TCP:$registry_cache_upstream"');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('http://127.0.0.1:5000/v2/');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('"registry-mirrors": ["http://10.0.2.2:5000"]');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("DIM_CI_REGISTRY_CACHE_UPSTREAM=10.0.2.2:5000");
    const userData = QEMU_CI_SUPERVISOR_SCRIPT.match(/cat >"\$cleanup_dir\/user-data" <<EOF\n([\s\S]*?)\nEOF/)?.[1];
    expect(userData).toBeDefined();
    expect(userData).not.toContain("GITEA_RUNNER_REGISTRATION_TOKEN");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("--ephemeral");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("printf '%s\\n' \"$GITEA_RUNNER_REGISTRATION_TOKEN\" | ssh");
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('selected = "dim-qemu" in workflow_job.get("labels", [])');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('action in ("queued", "in_progress", "completed")');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('"/var/lib/dim-qemu-ci-dispatch/demand.json"');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain("fcntl.flock(lock, fcntl.LOCK_EX)");
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain("except subprocess.CalledProcessError as error:");
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain("queued demand remains; retrying");
  });

  it("ships a pinned Sysbox runner host image with Node.js for JavaScript actions", () => {
    expect(SYSBOX_CI_RUNNER_BASE_IMAGE).toMatch(/^gitea\/act_runner@sha256:[0-9a-f]{64}$/);
    expect(SYSBOX_CI_RUNNER_IMAGE).toMatch(/^dev-infra-manager-ci-runner:/);
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain(`FROM ${SYSBOX_CI_RUNNER_BASE_IMAGE}`);
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("node-v24.19.0-linux-x64-musl.tar.xz");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("ebcb19941bf6a34ada2141727ffda66fb2a4bf315f5c02c8f1fc9e48a2045e06");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("node --version");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("just=1.40.0-r0");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("jq");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("socat");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("just --version");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("dim-ci-runner-health");
    expect(spawnSync("bash", ["-n"], { input: SYSBOX_CI_RUNNER_HEALTH_SCRIPT }).status).toBe(0);
    expect(SYSBOX_CI_RUNNER_HEALTH_SCRIPT).toContain("mount -t tmpfs");
    expect(SYSBOX_CI_RUNNER_HEALTH_SCRIPT).toContain("docker run --rm alpine:3.22 true");
    expect(SYSBOX_CI_RUNNER_HEALTH_SCRIPT).toContain("kill -TERM 1");
  });

  it.runIf(hasPython)("keeps accepting queued jobs after a supervisor failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dim-qemu-webhook-"));
    temporaryDirectories.push(directory);
    const webhookPath = join(directory, "webhook.py");
    const supervisorPath = join(directory, "supervise.bash");
    const attemptsPath = join(directory, "attempts");
    const successPath = join(directory, "success");
    const releasePath = join(directory, "release");
    const statePath = join(directory, "scheduler-demand.json");
    const port = await availablePort();
    await writeFile(webhookPath, QEMU_CI_WEBHOOK_SCRIPT
      .replace("/usr/local/bin/dim-qemu-ci-supervise", supervisorPath)
      .replace("(\"0.0.0.0\", 8080)", `(\"127.0.0.1\", ${port})`));
    await writeFile(supervisorPath, `#!/usr/bin/env bash
set -eu
attempts=0
test ! -f '${attemptsPath}' || attempts="$(cat '${attemptsPath}')"
attempts="$((attempts + 1))"
printf '%s\\n' "$attempts" >'${attemptsPath}'
if [[ "$attempts" -eq 1 ]]; then exit 23; fi
touch '${successPath}'
while [[ ! -f '${releasePath}' ]]; do sleep 0.05; done
`);
    const webhook = spawn("python3", [webhookPath], {
      env: { ...process.env, DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer test", DIM_QEMU_CI_CAPACITY: "test-1", DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05", DIM_QEMU_SCHEDULER_STATE: statePath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    webhook.stdout.setEncoding("utf8");
    webhook.stderr.setEncoding("utf8");
    webhook.stdout.on("data", (chunk: string) => { output += chunk; });
    webhook.stderr.on("data", (chunk: string) => { output += chunk; });
    try {
      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/missing`);
          return response.status === 501;
        } catch {
          return false;
        }
      });
      await sendWorkflowJob(port, 101, "queued");
      await waitFor(async () => (await readFileIfPresent(attemptsPath)) === "1\n");
      await sendWorkflowJob(port, 101, "completed");
      await sendWorkflowJob(port, 102, "queued");
      await waitFor(async () => (await readFileIfPresent(successPath)) !== undefined);
      expect(await readFileIfPresent(attemptsPath)).toBe("2\n");
      await sendWorkflowJob(port, 102, "in_progress");
      await writeFile(releasePath, "\n");
      expect(output).toContain("supervisor failed: exit 23");
      expect(output).toContain("queued job 102");
    } finally {
      if (webhook.exitCode === null) {
        const closed = new Promise<void>((resolve) => webhook.once("close", () => resolve()));
        webhook.kill("SIGTERM");
        await closed;
      }
    }
  }, 15_000);

  it.runIf(hasPython)("retains queued demand until Gitea reports that a job started", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dim-qemu-scheduler-"));
    temporaryDirectories.push(directory);
    const webhookPath = join(directory, "webhook.py");
    const supervisorPath = join(directory, "supervise.bash");
    const attemptsPath = join(directory, "attempts");
    const releasePath = join(directory, "release");
    const statePath = join(directory, "scheduler-demand.json");
    const port = await availablePort();
    await writeFile(statePath, JSON.stringify({ queued: [201], running: [], claims: {} }));
    await writeFile(webhookPath, QEMU_CI_WEBHOOK_SCRIPT
      .replace("/usr/local/bin/dim-qemu-ci-supervise", supervisorPath)
      .replace("(\"0.0.0.0\", 8080)", `(\"127.0.0.1\", ${port})`));
    await writeFile(supervisorPath, `#!/usr/bin/env bash
set -eu
attempts=0
test ! -f '${attemptsPath}' || attempts="$(cat '${attemptsPath}')"
attempts="$((attempts + 1))"
printf '%s\n' "$attempts" >'${attemptsPath}'
if [[ "$attempts" -eq 1 ]]; then exit 0; fi
while [[ ! -f '${releasePath}' ]]; do sleep 0.05; done
`);
    const webhook = spawn("python3", [webhookPath], {
      env: { ...process.env, DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer test", DIM_QEMU_CI_CAPACITY: "test-1", DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05", DIM_QEMU_SCHEDULER_STATE: statePath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      await waitFor(async () => (await readFileIfPresent(attemptsPath)) === "2\n");
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ queued: [201], running: [] });
      await sendWorkflowJob(port, 201, "in_progress");
      await waitFor(async () => JSON.parse((await readFileIfPresent(statePath)) ?? "{}").running?.[0] === 201);
      await writeFile(releasePath, "\n");
      await sendWorkflowJob(port, 201, "completed");
      await waitFor(async () => JSON.parse(await readFile(statePath, "utf8")).queued.length === 0);
    } finally {
      if (webhook.exitCode === null) {
        const closed = new Promise<void>((resolve) => webhook.once("close", () => resolve()));
        webhook.kill("SIGTERM");
        await closed;
      }
    }
  }, 15_000);

  it.runIf(hasPython)("claims duplicate demand on only one named QEMU capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dim-qemu-shared-dispatch-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "demand.json");
    const releasePath = join(directory, "release");
    const processes: ReturnType<typeof spawn>[] = [];
    const ports = [await availablePort(), await availablePort()];
    for (const [index, port] of ports.entries()) {
      const webhookPath = join(directory, `webhook-${index}.py`);
      const supervisorPath = join(directory, `supervise-${index}.bash`);
      await writeFile(webhookPath, QEMU_CI_WEBHOOK_SCRIPT
        .replace("/usr/local/bin/dim-qemu-ci-supervise", supervisorPath)
        .replace("(\"0.0.0.0\", 8080)", `(\"127.0.0.1\", ${port})`));
      await writeFile(supervisorPath, `#!/usr/bin/env bash
set -eu
touch '${join(directory, `started-${index}`)}'
while [[ ! -f '${releasePath}' ]]; do sleep 0.05; done
`);
      processes.push(spawn("python3", [webhookPath], {
        env: { ...process.env, DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer test", DIM_QEMU_CI_CAPACITY: `capacity-${index}`, DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05", DIM_QEMU_SCHEDULER_STATE: statePath },
        stdio: "ignore"
      }));
    }
    try {
      await Promise.all(ports.map((port) => waitFor(async () => {
        try { return (await fetch(`http://127.0.0.1:${port}/missing`)).status === 501; }
        catch { return false; }
      })));
      await Promise.all(ports.map((port) => sendWorkflowJob(port, 301, "queued")));
      await waitFor(async () => [0, 1].filter((index) => spawnSync("test", ["-f", join(directory, `started-${index}`)]).status === 0).length === 1);
      expect([0, 1].filter((index) => spawnSync("test", ["-f", join(directory, `started-${index}`)]).status === 0)).toHaveLength(1);
      await Promise.all(ports.map((port) => sendWorkflowJob(port, 301, "in_progress")));
      await writeFile(releasePath, "\n");
    } finally {
      await writeFile(releasePath, "\n");
      await Promise.all(processes.map(async (process) => {
        if (process.exitCode !== null) return;
        const closed = new Promise<void>((resolve) => process.once("close", () => resolve()));
        process.kill("SIGTERM");
        await closed;
      }));
    }
  }, 15_000);
});

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate webhook test port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function sendWorkflowJob(port: number, id: number, action: "queued" | "in_progress" | "completed"): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/workflow-job`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "Content-Type": "application/json",
      "X-Gitea-Event": "workflow_job"
    },
    body: JSON.stringify({ action, workflow_job: { id, labels: ["dim-qemu"] } })
  });
  expect(response.status).toBe(202);
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for QEMU webhook test condition");
}

describe("CI runner state", () => {
  it("reads and lists independently named schema 4 runners", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const record = {
      schemaVersion: 4,
      name: "fast-1",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea",
      executor: { kind: "sysbox", phase: "ready", containerName: "dim-ci-example-fast-1", volumeName: "dim-ci-example-fast-1-data", image: "runner:image", runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "2026-08-18T00:00:00.000Z" },
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z"
    } satisfies CiRunnerRecord;
    const second = {
      ...record,
      name: "fast-2",
      executor: {
        ...record.executor,
        containerName: "dim-ci-example-fast-2",
        volumeName: "dim-ci-example-fast-2-data"
      }
    } satisfies CiRunnerRecord;

    await state.writeCiRunner(record);
    await state.writeCiRunner(second);

    await expect(state.readCiRunner("example", "fast-1")).resolves.toEqual(record);
    await expect(state.readCiRunner("example", "fast-2")).resolves.toEqual(second);
    await expect(state.listCiRunners()).resolves.toEqual([record, second]);
  });

  it("removes the Project state directory only after its last runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-remove-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const record = {
      schemaVersion: 4,
      name: "primary",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea-actions",
      executor: { kind: "sysbox", phase: "ready", containerName: "primary", volumeName: "primary-data", image: "runner:image", runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "now" },
      createdAt: "now",
      updatedAt: "now"
    } satisfies CiRunnerRecord;
    await state.writeCiRunner(record);
    await state.writeCiRunner({
      ...record,
      name: "secondary",
      executor: { ...record.executor, containerName: "secondary", volumeName: "secondary-data" }
    });

    await expect(state.removeCiRunner("example", "primary")).resolves.toBeUndefined();
    await expect(state.listCiRunners()).resolves.toEqual([expect.objectContaining({ name: "secondary" })]);
    await expect(stat(join(root, "ci-runners", "example"))).resolves.toBeDefined();

    await expect(state.removeCiRunner("example", "secondary")).resolves.toBeUndefined();
    await expect(state.listCiRunners()).resolves.toEqual([]);
    await expect(stat(join(root, "ci-runners", "example"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a runner record with a different schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-invalid-"));
    temporaryDirectories.push(root);
    const directory = join(root, "ci-runners", "example");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "fast-1.json"), JSON.stringify({ schemaVersion: 3, name: "fast-1" }));

    await expect(new LifecycleState(root).listCiRunners()).rejects.toThrow(
      "CI runner 'fast-1' uses unsupported state schema 3; expected 4"
    );
  });

});
