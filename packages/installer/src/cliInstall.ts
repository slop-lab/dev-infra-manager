import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readlink, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cliExecutable, hostExecutable, defaultDataHome, defaultUserConfigPath,
  defaultBinDirectory, readUserConfig, writeUserConfig
} from "./installConfig.js";
import {
  installManagedSymlink, restoreManagedSymlink, snapshotManagedSymlink,
  type ManagedSymlinkSnapshot
} from "./managedSymlink.js";
import { run } from "./runtimeFiles.js";
import { assertHostProtocolCompatible, queryHostProtocol } from "./hostProtocol.js";
import type { InstallerOperation } from "./installProgress.js";
import { queryCliVersion, validateConfiguredCli } from "./cliExecutable.js";

export { installManagedSymlink } from "./managedSymlink.js";
export { readCliPackageBundle, type LocalPackageBundle } from "./localPackageBundle.js";
export { queryCliVersion, validateConfiguredCli } from "./cliExecutable.js";

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
}
export interface InstalledCli {
  readonly executable: string;
  readonly version: string;
  readonly mode: "direct" | "proxied";
  readonly symlink?: string;
}

/** Presentation updates never install host plugins, run state preflight or restart a controller. */
export async function installDimCli(options: CliInstallOptions): Promise<InstalledCli> {
  const dataHome = path.resolve(options.dataHome ?? defaultDataHome());
  const managedRoot = path.join(dataHome, "cli", "runtime");
  const current = path.join(managedRoot, "current");
  const backup = path.join(managedRoot, `.previous-${process.pid}-${Date.now()}`);
  const specifiers = options.packageSpecifiers
    ?? (options.version ? [`@slop-lab/dim-cli@${options.version}`] : undefined);
  if (!specifiers) throw new Error("a CLI version or local package bundle is required");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(managedRoot, ".staging-"));
  let previousMoved = false;
  let promoted = false;
  let committed = false;
  let symlink: string | undefined;
  let symlinkSnapshot: ManagedSymlinkSnapshot | undefined;
  try {
    options.operation?.reportProgress("package installation");
    await run(options.npmCommand ?? "npm", [
      "install", "--prefix", stage, "--save-exact", "--no-fund", "--no-audit", ...specifiers
    ], stage, options.operation);
    options.operation?.reportProgress("version verification");
    const staged = path.join(stage, "node_modules", ".bin", "dim");
    await access(staged, constants.X_OK);
    const version = await queryCliVersion(staged);
    if (options.version && version !== options.version) {
      throw new Error(`installed DIM CLI reports ${version}, expected ${options.version}`);
    }
    options.operation?.reportProgress("protocol compatibility");
    await queryHostProtocol(staged);
    const host = hostExecutable(dataHome);
    let installedHost = true;
    try { await access(host, constants.X_OK); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      installedHost = false;
    }
    if (installedHost) await assertHostProtocolCompatible(host, staged);
    // The direct PATH entry also needs to select this installation's host endpoint.
    const underlying = path.join(current, "node_modules", ".bin", "dim");
    await writeFile(path.join(stage, "dim"), [
      "#!/bin/sh", `DIM_HOST_EXECUTABLE=${shellQuote(host)}`, "export DIM_HOST_EXECUTABLE",
      `exec ${shellQuote(underlying)} "$@"`, ""
    ].join("\n"), { mode: 0o755 });
    options.operation?.reportProgress("runtime promotion");
    try {
      await rename(current, backup);
      previousMoved = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(stage, current);
    promoted = true;
    const executable = cliExecutable(dataHome);
    const mode = options.exposeOnPath ? "direct" : "proxied";
    if (options.exposeOnPath) {
      symlink = path.join(path.resolve(options.binDirectory ?? defaultBinDirectory()), "dim");
      const linkRoot = await managedLinkRoot(symlink, dataHome, managedRoot);
      symlinkSnapshot = await snapshotManagedSymlink(symlink, linkRoot);
      await installManagedSymlink(symlink, executable, linkRoot);
    }
    options.operation?.reportProgress("configuration");
    const configPath = options.configPath ?? defaultUserConfigPath();
    const config = await readUserConfig(configPath);
    await writeUserConfig(configPath, { ...config, cli: { mode, version, executable } });
    committed = true;
    await rm(backup, { recursive: true, force: true });
    return { executable, mode, version, ...(symlink ? { symlink } : {}) };
  } catch (error) {
    if (!committed) {
      if (promoted) await rm(current, { recursive: true, force: true });
      if (previousMoved) await rename(backup, current);
      if (symlink && symlinkSnapshot) await restoreManagedSymlink(symlink, symlinkSnapshot);
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Only the exact former installer-owned CLI target may move out of the host prefix. */
async function managedLinkRoot(link: string, dataHome: string, cliRoot: string): Promise<string> {
  try {
    const target = path.resolve(path.dirname(link), await readlink(link));
    const former = path.join(dataHome, "runtime", "current", "node_modules", ".bin", "dim");
    return target === former ? path.join(dataHome, "runtime") : cliRoot;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "EINVAL") return cliRoot;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
