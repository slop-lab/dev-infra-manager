import { executionWorkerConfigSchema } from "@slop-lab/dim-contracts-ci/worker";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProcessRunner, UserError, type StreamingCommandRunner } from "@slop-lab/dim-host-core";
import { executionWorkerClient } from "./client.js";
import { runExecutionWorker } from "./worker.js";
import { createSysboxBackend } from "./backends/sysbox.js";
import type { HostExecutionRouting } from "@slop-lab/dim-host-core/workspace";
import { createQemuBackend } from "./backends/qemu.js";
import type { ExecutionTaskHandler } from "@slop-lab/dim-task-scheduling";
export async function runCiWorker(path: string, signal: AbortSignal, options: { runner?: StreamingCommandRunner; routingProvider?: () => Promise<HostExecutionRouting | undefined>; taskHandlers?: readonly ExecutionTaskHandler[] } = {}): Promise<void> {
  const runner = options.runner ?? new ProcessRunner();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > 64 * 1024) throw new UserError("CI worker config must be an owned mode-0600 file");
    config = executionWorkerConfigSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
  // Refuse unusable capacity before it can reserve a candidate execution.
  if (config.slots.some((slot) => "runtime" in slot)) {
    const docker = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], { signal });
    if (docker.exitCode !== 0) throw new UserError("CI worker requires a working Docker daemon");
    const runtimes: unknown = JSON.parse(docker.stdout);
    if (config.slots.some((slot) => "runtime" in slot && slot.runtime === "container") && (typeof runtimes !== "object" || runtimes === null
      || !Object.hasOwn(runtimes, "sysbox-runc"))) throw new UserError("CI Sysbox slots require registered sysbox-runc");
  }
  if (config.slots.some((slot) => "runtime" in slot && slot.runtime === "vm")) {
    const kvm = await stat("/dev/kvm");
    if (!kvm.isCharacterDevice()) throw new UserError("CI QEMU slots require /dev/kvm");
    const device = await open("/dev/kvm", constants.O_RDWR | constants.O_NOFOLLOW);
    await device.close();
  }
  for (const slot of config.slots) if ("taskType" in slot && !options.taskHandlers?.some((handler) => handler.taskType === slot.taskType && handler.revision === slot.handlerRevision)) throw new UserError(`execution slot ${slot.id} requires its exact configured task handler`);
  const routing = config.slots.some((slot) => "runtime" in slot) ? await options.routingProvider?.() : undefined;
  const stop = new AbortController(), workerSignal = AbortSignal.any([signal, stop.signal]);
  const workers = config.slots.map((slot) => runExecutionWorker({
    directory: join(config.stateDirectory, slot.id), client: executionWorkerClient({ endpoint: config.endpoint,
      workerId: config.workerId, slotId: slot.id, token: config.token, generationId: config.generationId }),
    ...("runtime" in slot ? { backend: slot.runtime === "container" ? createSysboxBackend(routing) : createQemuBackend(routing) } : {}), runner,
    taskHandlers: "taskType" in slot ? options.taskHandlers!.filter((handler) => handler.taskType === slot.taskType && handler.revision === slot.handlerRevision) : [],
    ...(config.nativeGitEndpoint === undefined ? {} : { gitEndpoint: config.nativeGitEndpoint }),
    ...(config.gitExecutable === undefined ? {} : { gitExecutable: config.gitExecutable }), signal: workerSignal
  }));
  try { await Promise.all(workers); }
  catch (error) { stop.abort(); await Promise.allSettled(workers); if (!signal.aborted) throw error; }
}
