import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { BUILTIN_CI_RUNNER_DEFAULTS, ciRunnerContainerArgs, ciRunnerContainerName, ciRunnerQemuDispatchVolumeName, ciRunnerQemuRunnerName, ciRunnerQemuSupervisorName, ciRunnerQemuVolumeName, detectCiRunnerKvm, effectiveCiRunnerResources, effectiveQemuCiRunnerResources, qemuMemoryMiB } from "../../../../core/packages/core/src/ciRunner.js";
import { ciRunnerQemuProjectCacheVolumeName } from "../../../../core/packages/core/src/qemuCiRunnerLifecycle.js";
import { giteaCiRunnerApiBase } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { QEMU_CI_COMMON_PROVISION_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";
import { QEMU_CI_SUPERVISOR_DOCKERFILE, QEMU_CI_SUPERVISOR_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerSupervisorAssets.js";
import { QEMU_CI_WEBHOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerWebhookAsset.js";
import { SYSBOX_CI_RUNNER_BASE_IMAGE, SYSBOX_CI_RUNNER_DOCKERFILE, SYSBOX_CI_RUNNER_IMAGE } from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";
import { availablePort, hasPython, options, readFileIfPresent, runnerLabels, sendWorkflowJob, temporaryDirectories, waitFor } from "./ciRunnerFixture.js";

describe("CI runner resources", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
      env: { ...process.env, DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer test", DIM_QEMU_CI_CAPACITY: "test-1", DIM_QEMU_CI_LABELS: "dim-qemu", DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05", DIM_QEMU_SCHEDULER_STATE: statePath },
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
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
            headers: { Authorization: "Bearer test" }
          });
          return response.status === 200;
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
      env: { ...process.env, DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer test", DIM_QEMU_CI_CAPACITY: "test-1", DIM_QEMU_CI_LABELS: "dim-qemu", DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05", DIM_QEMU_SCHEDULER_STATE: statePath },
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
        env: { ...process.env, DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer test", DIM_QEMU_CI_CAPACITY: `capacity-${index}`, DIM_QEMU_CI_LABELS: "dim-qemu", DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05", DIM_QEMU_SCHEDULER_STATE: statePath },
        stdio: "ignore"
      }));
    }
    try {
      await Promise.all(ports.map((port) => waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/healthz`, {
            headers: { Authorization: "Bearer test" }
          })).status === 200;
        }
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
