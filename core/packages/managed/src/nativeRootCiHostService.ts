import { join } from "node:path";
import { UserError } from "@slop-lab/dim-core";
import { createNativeRootCiHostClient } from "./nativeRootCiHostClient.js";
import { loadNativeRootCiHostConfig } from "./nativeRootCiHostConfig.js";
import {
  acquireNativeRootCiHostCapacityGuard,
  serveNativeRootCiHostCapacity
} from "./nativeRootCiHostWorker.js";
import { ProcessRunner } from "@slop-lab/dim-core";
import { ensureRegistryCache } from "./registryCache.js";
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
  await ensureRegistryCache(runner, options);
  const capacityInputs = config.capacities.map((capacity) => ({ capacity,
    client: createNativeRootCiHostClient({ hostId: config.hostId, capacity, generationId: config.generationId,
      ordinaryCi: { endpoint: config.ordinaryCi.endpoint, serviceId: config.ordinaryCi.serviceId,
        credential: config.ordinaryCi.credential },
      nativeGit: { endpoint: config.nativeGit.endpoint, serviceId: config.nativeGit.serviceId } }),
    journalPath: join(config.stateDirectory, `${capacity}.json`) }));
  const guardedInputs = [];
  try {
    for (const input of capacityInputs) guardedInputs.push({ ...input,
      capacityGuard: await acquireNativeRootCiHostCapacityGuard(input.journalPath) });
  } catch (error) {
    await Promise.all(guardedInputs.map(({ capacityGuard }) => capacityGuard.release()));
    throw error;
  }
  const controller = new AbortController();
  const workerSignal = AbortSignal.any([signal, controller.signal]);
  const workers = guardedInputs.map(async (input) => {
    try {
      await serveNativeRootCiHostCapacity({ client: input.client, runner,
        gitExecutable: config.gitExecutable, nativeGitEndpoint: config.nativeGit.endpoint,
        journalPath: input.journalPath, capacityGuard: input.capacityGuard }, workerSignal);
    } finally { await input.capacityGuard.release(); }
  });
  try {
    await Promise.all(workers);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(workers);
    throw error;
  }
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
