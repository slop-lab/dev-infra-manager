import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { executionWorkerConfigSchema } from "@slop-lab/dim-contracts-ci/worker";
import { executionIdentifierSchema } from "@slop-lab/dim-contracts-execution/config";
import { createExecutionCapacityClient } from "@slop-lab/dim-service-client-execution";
import { tryAcquireKernelGuard } from "@slop-lab/dim-host-core";
import { runConfiguredHostExecutionWorker, type HostExecutionWorkerOptions } from "./host.js";
import { historicalCapacityArtifacts } from "./capacity-journals.js";
import { runExecutionCapacityReconciler, type ExecutionCapacityAdapter } from "./capacity-reconciler.js";

const configuration = z.object({ schemaVersion: z.literal(1), connectionFile: z.string().refine(isAbsolute),
  stateDirectory: z.string().refine(isAbsolute), pollMilliseconds: z.number().int().min(1_000).max(60_000),
  members: z.array(z.object({ workerId: executionIdentifierSchema, configFile: z.string().refine(isAbsolute) }).strict()).min(1).max(64)
}).strict();
type WorkerConfig = ReturnType<typeof executionWorkerConfigSchema.parse>;
async function privateJson(path: string, maximum = 65536): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) throw new Error("capacity inputs must be private owned regular files");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally { await file.close(); }
}
/** In-process host worker loops use the existing backends, routing and exact private slot guards. */
export function createHostCapacityAdapter(workers: readonly WorkerConfig[], run: typeof runConfiguredHostExecutionWorker,
  options: HostExecutionWorkerOptions = {}, report?: (message: string) => void): ExecutionCapacityAdapter {
  const active = new Map<string, { instance: string; controller: AbortController; finished: boolean; failed: boolean; promise: Promise<void> }>();
  const config = (id: string) => { const value = workers.find(w => w.workerId === id); if (!value) throw new Error("worker is outside the local pool"); return value; };
  return {
    async observe(workerId) {
      const worker = config(workerId), current = active.get(workerId);
      return { workerId, state: current === undefined ? "stopped" : current.finished ? current.failed ? "failed" : "stopped" : "running",
        clean: await capacityWorkerClean(worker), ...(current === undefined ? {} : { instance: current.instance }) };
    },
    async start(workerId) {
      const worker = config(workerId), previous = active.get(workerId);
      if (previous && !previous.finished) return;
      const controller = new AbortController();
      const current = { instance: randomUUID(), controller, finished: false, failed: false, promise: Promise.resolve() };
      active.set(workerId, current);
      current.promise = run(worker, controller.signal, options).catch(() => { current.failed = true; report?.(`Capacity worker ${workerId} failed; retained journals fence normal recovery.`); }).finally(() => { current.finished = true; });
    },
    async stop(workerId, expectedInstance) {
      const current = active.get(workerId);
      if (!current || current.instance !== expectedInstance || !await capacityWorkerClean(config(workerId)) || active.get(workerId) !== current) throw new Error("capacity worker instance or cleanup changed before stop");
      current.controller.abort(); await current.promise;
    }
  };
}
export async function capacityWorkerClean(worker: WorkerConfig): Promise<boolean> {
  for (const slot of worker.slots) {
    const directory = join(worker.stateDirectory, slot.id);
    let names: string[];
    try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) return false; names = await readdir(directory); }
    catch (error) { if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue; throw error; }
    if (names.some(name => name !== "worker.guard" && !/^artifacts-[0-9a-f-]{36}$/.test(name))) return false;
    if (names.includes("worker.guard")) {
      const guard = await lstat(join(directory, "worker.guard"));
      if (!guard.isFile() || guard.isSymbolicLink() || guard.uid !== process.geteuid?.() || guard.nlink !== 1 || (guard.mode & 0o077) !== 0) return false;
    }
    for (const name of names.filter(n => n.startsWith("artifacts-"))) {
      const id = name.slice("artifacts-".length), root = join(directory, name), stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) return false;
      if (!await historicalCapacityArtifacts(root, id)) return false;
    }
  }
  return true;
}
export async function runHostExecutionCapacity(file: string, signal: AbortSignal, options: HostExecutionWorkerOptions = {}): Promise<void> {
  if (!isAbsolute(file)) throw new Error("capacity config path must be absolute");
  const parsed = configuration.parse(await privateJson(file));
  if (new Set(parsed.members.map(m => m.workerId)).size !== parsed.members.length) throw new Error("capacity worker identities must be unique");
  await mkdir(parsed.stateDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(parsed.stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0 || await realpath(parsed.stateDirectory) !== parsed.stateDirectory) throw new Error("capacity state root must be private and canonical");
  const guard = await tryAcquireKernelGuard(join(parsed.stateDirectory, "provider.guard"));
  if (!guard) throw new Error("capacity provider is already running");
  try {
    const client = await createExecutionCapacityClient(parsed.connectionFile);
    const workers = await Promise.all(parsed.members.map(async member => {
      const worker = executionWorkerConfigSchema.parse(await privateJson(member.configFile));
      if (worker.workerId !== member.workerId || worker.generationId !== client.generationId || worker.endpoint !== client.endpoint) throw new Error("capacity worker config identity conflicts");
      return worker;
    }));
    if (new Set(workers.map(w => w.stateDirectory)).size !== workers.length) throw new Error("capacity workers must have separate state roots");
    const report = (message: string) => { process.stderr.write(message + "\n"); };
    await runExecutionCapacityReconciler({ client, adapter: createHostCapacityAdapter(workers, runConfiguredHostExecutionWorker, options, report),
      workerIds: workers.map(w => w.workerId), signal, pollMilliseconds: parsed.pollMilliseconds, report });
  } finally { await guard.release(); }
}
