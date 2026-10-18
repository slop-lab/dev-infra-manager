import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ProcessRunner, UserError, type StreamingCommandRunner } from "@slop-lab/dim-core";
import { executionWorkerClient } from "./client.js";
import { runExecutionWorker } from "./worker.js";
import { createSysboxBackend } from "./backends/sysbox.js";
import { lifecycleOptions } from "../lifecycleOptions.js";
import type { LifecycleOptions } from "../lifecycleTypes.js";
import { CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, ensureRegistryCache, sysboxRegistryDaemonConfig } from "../registryCache.js";
import { qemuBackend } from "./backends/qemu.js";
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === value && url.username === "" && url.password === ""
      && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
});
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const executionWorkerConfigSchema = z.object({ schemaVersion: z.literal(1), workerId: identifier,
  generationId: z.string().regex(/^[0-9a-f]{64}$/), stateDirectory: z.string().refine(isAbsolute),
  gitExecutable: z.string().refine(isAbsolute), endpoint: origin, nativeGitEndpoint: origin,
  token: z.string().regex(/^[A-Za-z0-9_-]{43,}$/), slots: z.array(z.object({ id: identifier,
    runtime: z.enum(["sysbox", "qemu"]) }).strict().readonly()).min(1).readonly()
}).strict().readonly().refine((config) => new Set(config.slots.map((slot) => slot.id)).size === config.slots.length);
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
  if (config.slots.some((slot) => slot.runtime === "sysbox") && (typeof runtimes !== "object" || runtimes === null
    || !Object.hasOwn(runtimes, "sysbox-runc"))) throw new UserError("CI Sysbox slots require registered sysbox-runc");
  if (config.slots.some((slot) => slot.runtime === "qemu")) {
    const kvm = await stat("/dev/kvm");
    if (!kvm.isCharacterDevice()) throw new UserError("CI QEMU slots require /dev/kvm");
    const device = await open("/dev/kvm", constants.O_RDWR | constants.O_NOFOLLOW);
    await device.close();
  }
  const lifecycle = options.lifecycle ?? lifecycleOptions();
  const routing = lifecycle.hostMirrorProvider === undefined ? undefined : {
    network: CONTROL_NETWORK, blockedHostnames: DOCKER_HUB_DIRECT_HOSTNAMES, dockerDaemonConfig: sysboxRegistryDaemonConfig()
  };
  if (routing !== undefined && config.slots.some((slot) => slot.runtime === "sysbox")) await ensureRegistryCache(runner, lifecycle);
  const stop = new AbortController(), workerSignal = AbortSignal.any([signal, stop.signal]);
  const workers = config.slots.map((slot) => runExecutionWorker({
    directory: join(config.stateDirectory, slot.id), client: executionWorkerClient({ endpoint: config.endpoint,
      workerId: config.workerId, slotId: slot.id, token: config.token, generationId: config.generationId }),
    backend: slot.runtime === "sysbox" ? createSysboxBackend(routing) : qemuBackend, runner,
    gitEndpoint: config.nativeGitEndpoint, gitExecutable: config.gitExecutable, signal: workerSignal
  }));
  try { await Promise.all(workers); }
  catch (error) { stop.abort(); await Promise.allSettled(workers); if (!signal.aborted) throw error; }
}
