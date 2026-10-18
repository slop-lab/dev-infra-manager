import { join } from "node:path";
import { UserError } from "@slop-lab/dim-core";
import { executionWorkerClient } from "./ci/client.js";
import { runExecutionWorker } from "./ci/worker.js";
import { sysboxBackend } from "./ci/backends/sysbox.js";
import { loadNativeRootCiHostConfig } from "./nativeRootCiHostConfig.js";
import { ProcessRunner } from "@slop-lab/dim-core";
import { CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, sysboxRegistryDaemonConfig, ensureRegistryCache } from "./registryCache.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";

export async function runNativeRootCiHost(
  configPath: string,
  signal: AbortSignal,
  options: LifecycleOptions,
  runner: StreamingCommandRunner = new ProcessRunner()
): Promise<void> {
  const config = await loadNativeRootCiHostConfig(configPath);
  await requireSysboxRuntime(runner, signal);
  const controller = new AbortController();
  const workerSignal = AbortSignal.any([signal, controller.signal]);
  const workers = config.capacities.map((slotId) => runExecutionWorker({
    directory: join(config.stateDirectory, slotId),
    client: executionWorkerClient({ endpoint: config.ordinaryCi.endpoint, workerId: config.hostId,
      slotId, token: config.ordinaryCi.credential.password, generationId: config.generationId }),
    backend: sysboxBackend, runner, gitExecutable: config.gitExecutable,
    gitEndpoint: config.nativeGit.endpoint, signal: workerSignal
  }));
  try { await Promise.all(workers); }
  catch (error) { controller.abort(); await Promise.allSettled(workers); if (!signal.aborted) throw error; }
}

async function requireSysboxRuntime(runner: StreamingCommandRunner, signal: AbortSignal): Promise<void> {
  const result = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], { signal });
  if (result.exitCode !== 0) {
    throw new NativeRootCiHostPrerequisiteError("Docker runtime inspection failed; run 'dim doctor'");
  }
  let runtimes: unknown;
  try { runtimes = JSON.parse(result.stdout); }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new NativeRootCiHostPrerequisiteError("Docker runtime inspection returned invalid JSON", { cause: error });
    }
    throw error;
  }
  if (typeof runtimes !== "object" || runtimes === null || Array.isArray(runtimes)
    || !Object.hasOwn(runtimes, "sysbox-runc")) {
    throw new NativeRootCiHostPrerequisiteError(
      "Docker runtime 'sysbox-runc' is required; install and register Sysbox, then run 'dim doctor'"
    );
  }
}

export class NativeRootCiHostPrerequisiteError extends UserError {
  readonly name = "NativeRootCiHostPrerequisiteError";
}
