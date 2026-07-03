import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "./errors.js";
import { repoPath } from "./gitHost.js";
import { deploySecretRuntime } from "./secretDeploy.js";
import type { CommandRunner, DevInfraConfig } from "./types.js";

export interface ControllerOptions {
  once: boolean;
  intervalSeconds: number;
  dryRun: boolean;
}

export interface ControllerTickResult {
  currentSha: string;
  previousSha?: string;
  deployed: boolean;
}

export type DeployFunction = (config: DevInfraConfig, runner: CommandRunner, dryRun: boolean) => Promise<void>;

export function controllerStatePath(config: DevInfraConfig): string {
  return join(config.stateRoot, "controller", "secret-runtime.json");
}

export function controllerLockPath(config: DevInfraConfig): string {
  return join(config.stateRoot, "controller", "secret-runtime.lock");
}

export async function controllerTick(
  config: DevInfraConfig,
  runner: CommandRunner,
  dryRun: boolean,
  deploy: DeployFunction = deploySecretRuntime
): Promise<ControllerTickResult> {
  const currentSha = await approvedRefSha(config, runner);
  const previousSha = await readLastDeployedSha(config);
  if (previousSha === currentSha) {
    return { currentSha, previousSha, deployed: false };
  }

  return withControllerLock(config, async () => {
    const lockedPreviousSha = await readLastDeployedSha(config);
    if (lockedPreviousSha === currentSha) {
      return { currentSha, previousSha: lockedPreviousSha, deployed: false };
    }

    await deploy(config, runner, dryRun);
    if (!dryRun) {
      await writeLastDeployedSha(config, currentSha);
    }
    return lockedPreviousSha === undefined ? { currentSha, deployed: true } : { currentSha, previousSha: lockedPreviousSha, deployed: true };
  });
}

export async function runController(
  config: DevInfraConfig,
  runner: CommandRunner,
  options: ControllerOptions,
  deploy: DeployFunction = deploySecretRuntime
): Promise<void> {
  if (!Number.isSafeInteger(options.intervalSeconds) || options.intervalSeconds <= 0) {
    throw new UserError("controller interval must be a positive integer");
  }

  do {
    const result = await controllerTick(config, runner, options.dryRun, deploy);
    const action = result.deployed ? "deployed" : "unchanged";
    console.log(`${new Date().toISOString()} ${action} ${config.secretRuntime.repo}:${config.secretRuntime.approvedRef} ${result.currentSha}`);
    if (options.once) {
      return;
    }
    await sleep(options.intervalSeconds * 1000);
  } while (true);
}

async function approvedRefSha(config: DevInfraConfig, runner: CommandRunner): Promise<string> {
  const result = await runner.run("git", ["--git-dir", repoPath(config, config.secretRuntime.repo), "rev-parse", "--verify", config.secretRuntime.approvedRef]);
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to resolve approved ref: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function readLastDeployedSha(config: DevInfraConfig): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(controllerStatePath(config), "utf8")) as { lastDeployedSha?: unknown };
    return typeof raw.lastDeployedSha === "string" ? raw.lastDeployedSha : undefined;
  } catch {
    return undefined;
  }
}

async function writeLastDeployedSha(config: DevInfraConfig, sha: string): Promise<void> {
  const path = controllerStatePath(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ lastDeployedSha: sha, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function withControllerLock<T>(config: DevInfraConfig, callback: () => Promise<T>): Promise<T> {
  const path = controllerLockPath(config);
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UserError(`Controller deploy lock is already held: ${path}`);
    }
    throw error;
  }

  try {
    return await callback();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
