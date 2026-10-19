import { executionWorkerConfigSchema } from "./workerConfig.js";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProcessRunner, UserError, type StreamingCommandRunner } from "@slop-lab/dim-core";
import { executionWorkerClient } from "./client.js";
import { runExecutionWorker } from "./worker.js";
import { createSysboxBackend } from "./backends/sysbox.js";
import { lifecycleOptions } from "../lifecycleOptions.js";
import type { LifecycleOptions } from "../lifecycleTypes.js";
import { createQemuBackend } from "./backends/qemu.js";
export async function runCiWorker(path: string, signal: AbortSignal, options: { runner?: StreamingCommandRunner; lifecycle?: LifecycleOptions } = {}): Promise<void> {
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
  const docker = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], { signal });
  if (docker.exitCode !== 0) throw new UserError("CI worker requires a working Docker daemon");
  const runtimes: unknown = JSON.parse(docker.stdout);
  if (config.slots.some((slot) => slot.runtime === "container") && (typeof runtimes !== "object" || runtimes === null
    || !Object.hasOwn(runtimes, "sysbox-runc"))) throw new UserError("CI Sysbox slots require registered sysbox-runc");
  if (config.slots.some((slot) => slot.runtime === "vm")) {
    const kvm = await stat("/dev/kvm");
    if (!kvm.isCharacterDevice()) throw new UserError("CI QEMU slots require /dev/kvm");
    const device = await open("/dev/kvm", constants.O_RDWR | constants.O_NOFOLLOW);
    await device.close();
  }
  const lifecycle = options.lifecycle ?? lifecycleOptions();
  const routing = await lifecycle.hostMirrorProvider?.ensure(runner);
  const stop = new AbortController(), workerSignal = AbortSignal.any([signal, stop.signal]);
  const workers = config.slots.map((slot) => runExecutionWorker({
    directory: join(config.stateDirectory, slot.id), client: executionWorkerClient({ endpoint: config.endpoint,
      workerId: config.workerId, slotId: slot.id, token: config.token, generationId: config.generationId }),
    backend: slot.runtime === "container" ? createSysboxBackend(routing) : createQemuBackend(routing), runner,
    gitEndpoint: config.nativeGitEndpoint, gitExecutable: config.gitExecutable, signal: workerSignal
  }));
  try { await Promise.all(workers); }
  catch (error) { stop.abort(); await Promise.allSettled(workers); if (!signal.aborted) throw error; }
}
