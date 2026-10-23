import { queryCliVersion } from "./cliInstall.js";
import { assertHostProtocolCompatible, queryHostProtocol } from "./hostProtocol.js";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  hostExecutable,
  defaultDataHome,
  defaultUserConfigPath,
  readUserConfig,
  writeUserConfig,
} from "./installConfig.js";
import { prepareRuntimePluginGraph, verifySelectedPlugins, type RuntimePluginSelection } from "./runtimePluginGraph.js";
import { atomicWrite, run } from "./runtimeFiles.js";
import { runStagedStatePreflight } from "./statePreflight.js";
import type { InstallerOperation } from "./installProgress.js";
import { managedControllerIsActive } from "./controllerActivation.js";

export type { RuntimePluginSelection } from "./runtimePluginGraph.js";

export interface HostRuntimeInstallOptions {
  readonly version?: string;
  readonly packageSpecifiers?: readonly string[];
  readonly packageNames?: readonly string[];
  readonly configPath?: string;
  readonly dataHome?: string;
  readonly npmCommand?: string;
  readonly operation?: InstallerOperation;
  readonly restartController?: boolean;
  readonly plugins?: readonly RuntimePluginSelection[];
  /** Initial facade bootstrap runs only after the candidate accepts current state. */
  readonly prepareCli?: () => Promise<void>;
}

export { readHostPackageBundle, type LocalPackageBundle } from "./localPackageBundle.js";

export interface InstalledHostRuntime {
  readonly executable: string;
  readonly version: string;
}

export async function installHostRuntime(options: HostRuntimeInstallOptions): Promise<InstalledHostRuntime> {
  const dataHome = path.resolve(options.dataHome ?? defaultDataHome());
  const managedRoot = path.join(dataHome, "runtime");
  const currentDirectory = path.join(managedRoot, "current");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const existingControllerActive = await managedControllerIsActive(currentDirectory);
  const restartController = options.restartController ?? existingControllerActive;
  const stagingDirectory = await mkdtemp(path.join(managedRoot, ".staging-"));
  const requestedPackages = options.packageSpecifiers
    ?? (options.version ? [`@slop-lab/dim-host-core@${options.version}`] : undefined);
  if (!requestedPackages) throw new Error("a host version or local package bundle is required");
  const selectedPlugins = options.plugins ?? [];
  const pluginGraph = await prepareRuntimePluginGraph(currentDirectory, selectedPlugins, options.packageNames ?? [], options.version);
  const packageSpecifiers = [...requestedPackages, ...pluginGraph.specifiers];
  const configPath = options.configPath ?? defaultUserConfigPath();
  const backupDirectory = path.join(managedRoot, `.previous-${process.pid}-${Date.now()}`);
  let previousMoved = false;
  let promoted = false;
  let committed = false;
  let controllerRestartAttempted = false;
  let targetControllerReady = false;
  try {
    await run(options.npmCommand ?? "npm", [
      "install", "--prefix", stagingDirectory, "--save-exact", "--no-fund", "--no-audit",
      ...packageSpecifiers
    ], stagingDirectory, options.operation);
    options.operation?.reportProgress("version verification");
    const stagingExecutable = path.join(stagingDirectory, "node_modules", ".bin", "dim-host");
    await access(stagingExecutable, constants.X_OK);
    const installedVersion = await queryCliVersion(stagingExecutable);
    if (options.version && installedVersion !== options.version) {
      throw new Error(`installed DIM host reports ${installedVersion}, expected ${options.version}`);
    }
    await verifySelectedPlugins(stagingDirectory, selectedPlugins);
    options.operation?.reportProgress("protocol compatibility");
    await queryHostProtocol(stagingExecutable);
    options.operation?.reportProgress("state preflight");
    await runStagedStatePreflight(stagingDirectory);
    await options.prepareCli?.();
    const retainedCli = (await readUserConfig(configPath)).cli;
    if (retainedCli !== undefined) await assertHostProtocolCompatible(stagingExecutable, retainedCli.executable);
    await atomicWrite(path.join(stagingDirectory, "plugins.json"), pluginGraph.manifest);
    options.operation?.reportProgress("runtime promotion");
    try {
      await rename(currentDirectory, backupDirectory);
      previousMoved = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(stagingDirectory, currentDirectory);
    promoted = true;
    const executable = hostExecutable(dataHome);
    await access(executable, constants.X_OK);
    if (restartController) {
      controllerRestartAttempted = true;
      options.operation?.reportProgress("controller readiness");
      try {
        await run(executable, ["controller", "restart"], currentDirectory, options.operation);
        targetControllerReady = true;
      } catch (error) {
        throw new Error("target controller restart/readiness failed", { cause: error });
      }
    }
    options.operation?.reportProgress("configuration");
    const config = await readUserConfig(configPath);
    await writeUserConfig(configPath, { ...config, host: { version: installedVersion, executable } });
    committed = true;
    await cleanupRuntimeSiblings(managedRoot);
    return { executable, version: installedVersion };
  } catch (error) {
    if (!committed) {
      if (promoted && targetControllerReady) {
        options.operation?.activity();
        try {
          await run(hostExecutable(dataHome), ["controller", "stop"], currentDirectory);
        } catch (stopError) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(detail, {
            cause: new AggregateError([error, stopError], "target controller stop failed; rollback was not applied")
          });
        }
      }
      if (promoted) await rm(currentDirectory, { recursive: true, force: true });
      if (previousMoved) {
        await rename(backupDirectory, currentDirectory);
        if (controllerRestartAttempted) {
          options.operation?.activity();
          await run(hostExecutable(dataHome), ["controller", "restart"], currentDirectory);
        }
      }
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function cleanupRuntimeSiblings(managedRoot: string): Promise<void> {
  const entries = await readdir(managedRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== "current" && entry.name !== "sources")
    .map((entry) => rm(path.join(managedRoot, entry.name), { recursive: true, force: true })));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
