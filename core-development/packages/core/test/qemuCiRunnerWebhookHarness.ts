import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { QEMU_CI_WEBHOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerWebhookAsset.js";

export type SchedulerState = {
  readonly queued: readonly number[];
  readonly running: readonly number[];
  readonly claims: Readonly<Record<string, SchedulerClaim>>;
  readonly completed?: Readonly<Record<string, number>>;
};

type SchedulerClaim = {
  readonly owner: string;
  readonly updated: number;
};

export type Scheduler = {
  readonly port: number;
  readonly process: ReturnType<typeof spawn>;
  readonly statePath: string;
};

type SchedulerOptions = {
  readonly capacity: string;
  readonly labels?: readonly string[];
  readonly pythonSetup?: string;
  readonly shutdownMarkerPath?: string;
  readonly startWorker?: boolean;
  readonly supervisorWaitTimeoutSeconds?: number;
};

const temporaryDirectories: string[] = [];

export async function cleanupWebhookTests(): Promise<void> {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function schedulerDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dim-qemu-${name}-`));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "supervise.bash"), "#!/usr/bin/env bash\nexit 0\n");
  return directory;
}

export async function startScheduler(directory: string, options: SchedulerOptions): Promise<Scheduler> {
  const port = await availablePort();
  const statePath = join(directory, "demand.json");
  const webhookPath = join(directory, `webhook-${options.capacity}.py`);
  const workerStart = "worker_thread = threading.Thread(target=worker)";
  const pythonSetup = options.pythonSetup ?? "";
  const scriptWithSetup = QEMU_CI_WEBHOOK_SCRIPT
    .replace("/usr/local/bin/dim-qemu-ci-supervise", join(directory, "supervise.bash"))
    .replace("/var/lib/dim-qemu-ci/runs", join(directory, "runs"))
    .replace("(\"0.0.0.0\", 8080)", `(\"127.0.0.1\", ${port})`)
    .replace(workerStart, `${pythonSetup}\n${options.startWorker === false ? "worker_thread = threading.Thread(target=shutdown.wait)" : workerStart}`);
  const script = options.shutdownMarkerPath === undefined
    ? scriptWithSetup
    : scriptWithSetup.replace(
      "    shutdown.set()",
      `    shutdown.set()\n    with open(${JSON.stringify(options.shutdownMarkerPath)}, "w", encoding="utf-8"):\n        pass`
    );
  const scriptWithTestTimeout = options.supervisorWaitTimeoutSeconds === undefined
    ? script
    : script.replace("process.wait(timeout=5)", `process.wait(timeout=${options.supervisorWaitTimeoutSeconds})`);
  await writeFile(webhookPath, scriptWithTestTimeout);
  const process = spawn("python3", [webhookPath], {
    env: {
      ...globalThis.process.env,
      DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer test",
      DIM_QEMU_CI_CAPACITY: options.capacity,
      DIM_QEMU_CI_LABELS: (options.labels ?? ["dim-qemu"]).join(","),
      DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05",
      DIM_QEMU_SCHEDULER_STATE: statePath
    },
    stdio: "ignore"
  });
  const scheduler = { port, process, statePath };
  const processFailed = new Promise<never>((_resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      reject(new Error(`QEMU webhook test scheduler exited before readiness: ${code ?? signal}`));
    });
  });
  try {
    await Promise.race([
      waitFor(async () => {
        try {
          return await schedulerHealthStatus(port) === 200;
        } catch {
          return false;
        }
      }),
      processFailed
    ]);
    return scheduler;
  } catch (error) {
    await stopScheduler(scheduler);
    throw error;
  }
}

export async function stopScheduler(scheduler: Scheduler): Promise<void> {
  if (scheduler.process.exitCode !== null) return;
  const terminated = await signalScheduler(scheduler, "SIGTERM");
  if (terminated) return;
  const closed = new Promise<boolean>((resolve) => scheduler.process.once("close", () => resolve(true)));
  scheduler.process.kill("SIGKILL");
  const killed = await Promise.race([
    closed,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
  ]);
  if (!killed) throw new Error("timed out stopping QEMU webhook test scheduler");
}

export async function signalScheduler(
  scheduler: Scheduler,
  shutdownSignal: "SIGTERM" | "SIGINT"
): Promise<boolean> {
  if (scheduler.process.exitCode !== null) return true;
  const closed = new Promise<boolean>((resolve) => scheduler.process.once("close", () => resolve(true)));
  scheduler.process.kill(shutdownSignal);
  return Promise.race([
    closed,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
  ]);
}

export async function schedulerState(path: string): Promise<SchedulerState> {
  return JSON.parse(await readFile(path, "utf8"));
}

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

export async function sendWorkflowJob(
  port: number,
  id: number,
  action: "queued" | "in_progress" | "completed"
): Promise<void> {
  expect(await workflowJobStatus(port, id, action)).toBe(202);
}

export async function workflowJobStatus(
  port: number,
  id: number,
  action: "queued" | "in_progress" | "completed",
  labels: readonly string[] = ["dim-qemu"]
): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/workflow-job`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test",
      "Content-Type": "application/json",
      "X-Gitea-Event": "workflow_job"
    },
    body: JSON.stringify({ action, workflow_job: { id, labels } })
  });
  return response.status;
}

export async function schedulerHealthStatus(port: number): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { Authorization: "Bearer test" }
  })).status;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for QEMU webhook test condition");
}

export async function conditionWithin(condition: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

export async function recordedPids(path: string): Promise<readonly number[]> {
  return (await recordedLines(path)).map((value) => Number(value));
}

export async function recordedLines(path: string): Promise<readonly string[]> {
  if (!(await pathExists(path))) return [];
  return (await readFile(path, "utf8")).split("\n").filter((value) => value.length > 0);
}

export async function stopRecordedProcesses(path: string): Promise<void> {
  const pids = await recordedPids(path);
  for (const pid of pids) spawnSync("kill", ["-TERM", String(pid)]);
  if (await conditionWithin(async () => recordedProcessesStopped(pids))) return;
  for (const pid of pids) spawnSync("kill", ["-KILL", String(pid)]);
  await waitFor(async () => recordedProcessesStopped(pids));
}

export async function recordedProcessesStopped(pids: readonly number[]): Promise<boolean> {
  const stopped = await Promise.all(pids.map(async (pid) => !(await pathExists(`/proc/${pid}`))));
  return stopped.every(Boolean);
}

export async function killRecordedProcesses(paths: readonly string[]): Promise<void> {
  const pids = (await Promise.all(paths.map(async (path) => recordedPids(path)))).flat();
  for (const pid of pids) spawnSync("kill", ["-KILL", String(pid)]);
  await waitFor(async () => recordedProcessesStopped(pids));
}
