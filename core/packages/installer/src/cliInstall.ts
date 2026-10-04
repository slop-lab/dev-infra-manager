import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  cliExecutable,
  defaultBinDirectory,
  defaultDataHome,
  defaultUserConfigPath,
  readUserConfig,
  writeUserConfig,
  type DimCliConfig
} from "./installConfig.js";
import { prepareCliPluginGraph, verifySelectedPlugins, type CliPluginSelection } from "./cliPluginGraph.js";
import {
  installManagedSymlink,
  restoreManagedSymlink,
  snapshotManagedSymlink,
  type ManagedSymlinkSnapshot
} from "./managedSymlink.js";
import { atomicWrite, run } from "./runtimeFiles.js";
import { runStagedStatePreflight } from "./statePreflight.js";
import type { InstallerOperation } from "./installProgress.js";

export type { CliPluginSelection } from "./cliPluginGraph.js";
export { installManagedSymlink } from "./managedSymlink.js";

export interface CliInstallOptions {
  readonly version?: string;
  readonly packageSpecifiers?: readonly string[];
  readonly packageNames?: readonly string[];
  readonly exposeOnPath: boolean;
  readonly binDirectory?: string;
  readonly configPath?: string;
  readonly dataHome?: string;
  readonly npmCommand?: string;
  readonly operation?: InstallerOperation;
  readonly restartController?: boolean;
  readonly plugins?: readonly CliPluginSelection[];
}

export interface LocalPackageBundle {
  readonly packageSpecifiers: readonly string[];
  readonly packageNames: readonly string[];
}

export interface InstalledCli {
  readonly executable: string;
  readonly mode: "direct" | "proxied";
  readonly version: string;
  readonly symlink?: string;
}

export async function installDimCli(options: CliInstallOptions): Promise<InstalledCli> {
  const dataHome = path.resolve(options.dataHome ?? defaultDataHome());
  const managedRoot = path.join(dataHome, "runtime");
  const currentDirectory = path.join(managedRoot, "current");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(path.join(managedRoot, ".staging-"));
  const requestedPackages = options.packageSpecifiers
    ?? (options.version ? [`@slop-lab/dim-cli@${options.version}`] : undefined);
  if (!requestedPackages) throw new Error("a CLI version or local package bundle is required");
  const selectedPlugins = options.plugins ?? [];
  const pluginGraph = await prepareCliPluginGraph(currentDirectory, selectedPlugins, options.packageNames ?? []);
  const packageSpecifiers = [...requestedPackages, ...pluginGraph.specifiers];
  const configPath = options.configPath ?? defaultUserConfigPath();
  const backupDirectory = path.join(managedRoot, `.previous-${process.pid}-${Date.now()}`);
  let previousMoved = false;
  let promoted = false;
  let committed = false;
  let controllerRestartAttempted = false;
  let targetControllerReady = false;
  let installedSymlink: string | undefined;
  let symlinkSnapshot: ManagedSymlinkSnapshot | undefined;
  try {
    await run(options.npmCommand ?? "npm", [
      "install", "--prefix", stagingDirectory, "--save-exact", "--no-fund", "--no-audit",
      ...packageSpecifiers
    ], stagingDirectory, options.operation);
    options.operation?.reportProgress("version verification");
    const stagingExecutable = path.join(stagingDirectory, "node_modules", ".bin", "dim");
    await access(stagingExecutable, constants.X_OK);
    const installedVersion = await queryCliVersion(stagingExecutable);
    if (options.version && installedVersion !== options.version) {
      throw new Error(`installed DIM CLI reports ${installedVersion}, expected ${options.version}`);
    }
    await verifySelectedPlugins(stagingDirectory, selectedPlugins);
    options.operation?.reportProgress("state preflight");
    await runStagedStatePreflight(stagingDirectory);
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
    const executable = cliExecutable(dataHome);
    await access(executable, constants.X_OK);
    if (options.restartController !== false) {
      controllerRestartAttempted = true;
      options.operation?.reportProgress("controller readiness");
      try {
        await run(executable, ["controller", "restart"], currentDirectory, options.operation);
        targetControllerReady = true;
      } catch (error) {
        throw new Error("target controller restart/readiness failed", { cause: error });
      }
    }
    const mode = options.exposeOnPath ? "direct" : "proxied";
    if (options.exposeOnPath) {
      const binDirectory = path.resolve(options.binDirectory ?? defaultBinDirectory());
      installedSymlink = path.join(binDirectory, "dim");
      symlinkSnapshot = await snapshotManagedSymlink(installedSymlink, managedRoot);
      await installManagedSymlink(installedSymlink, executable, managedRoot);
    }
    options.operation?.reportProgress("configuration");
    const config = await readUserConfig(configPath);
    await writeUserConfig(configPath, { ...config, cli: { mode, version: installedVersion, executable } });
    committed = true;
    await cleanupRuntimeSiblings(managedRoot);
    return { executable, mode, version: installedVersion, ...(installedSymlink ? { symlink: installedSymlink } : {}) };
  } catch (error) {
    if (!committed) {
      if (promoted && targetControllerReady) {
        options.operation?.activity();
        try {
          await run(cliExecutable(dataHome), ["controller", "stop"], currentDirectory);
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
        if (installedSymlink && symlinkSnapshot) await restoreManagedSymlink(installedSymlink, symlinkSnapshot);
        if (controllerRestartAttempted) {
          options.operation?.activity();
          await run(cliExecutable(dataHome), ["controller", "restart"], currentDirectory);
        }
      }
      else if (installedSymlink && symlinkSnapshot) await restoreManagedSymlink(installedSymlink, symlinkSnapshot);
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function readLocalPackageBundle(directory: string): Promise<LocalPackageBundle> {
  const bundleDirectory = path.resolve(directory);
  const manifestPath = path.join(bundleDirectory, "packages.json");
  const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.packages)) {
    throw new Error(`invalid local package bundle manifest: ${manifestPath}`);
  }
  const packages = raw.packages.filter((entry) => isRecord(entry) && entry.name !== "@slop-lab/dim-installer");
  if (!packages.some((entry) => isRecord(entry) && entry.name === "@slop-lab/dim-cli")) {
    throw new Error("local package bundle does not contain @slop-lab/dim-cli");
  }
  const names = new Set<string>();
  const packageSpecifiers: string[] = [];
  for (const entry of packages) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.file !== "string") {
      throw new Error(`invalid local package entry in ${manifestPath}`);
    }
    if (names.has(entry.name)) throw new Error(`duplicate local package '${entry.name}'`);
    names.add(entry.name);
    if (path.basename(entry.file) !== entry.file || !entry.file.endsWith(".tgz")) {
      throw new Error(`invalid local package filename '${entry.file}'`);
    }
    const tarball = path.join(bundleDirectory, entry.file);
    await access(tarball, constants.R_OK);
    packageSpecifiers.push(tarball);
  }
  return { packageSpecifiers, packageNames: [...names] };
}

export async function validateConfiguredCli(cli: DimCliConfig, facadePath: string | undefined): Promise<string> {
  const executable = path.resolve(cli.executable);
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new Error(`DIM CLI ${cli.version} is configured at ${executable}, but it is not executable; run 'dim installer install core'`);
  }
  if (facadePath !== undefined) {
    try {
      if (await realpath(executable) === await realpath(facadePath)) {
        throw new Error("DIM CLI configuration points back to the installer facade");
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return executable;
}

export async function queryCliVersion(executable: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${executable} --version exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

async function cleanupRuntimeSiblings(managedRoot: string): Promise<void> {
  const entries = await readdir(managedRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== "current" && entry.name !== "sources")
    .map((entry) => rm(path.join(managedRoot, entry.name), { recursive: true, force: true })));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
