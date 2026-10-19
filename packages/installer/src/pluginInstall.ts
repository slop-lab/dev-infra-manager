import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatePluginTarget, assertControlPlaneClosure } from "./pluginTarget.js";
import { installerVersion } from "./installerVersion.js";

import { atomicWrite, readManifest, readPackageJson, run } from "./runtimeFiles.js";
import type { InstallerOperation } from "./installProgress.js";
import { managedControllerIsActive } from "./controllerActivation.js";

export type PluginTarget = "host" | "control-plane";
const CONTROL_PLANE_RUNTIME = "@slop-lab/dim-control-plane-core";

export interface InstallOptions {
  readonly pluginHome: string;
  readonly target?: PluginTarget;
  /** Reviewed source bundle override; otherwise the exact installer version is used. */
  readonly runtimeSpecifier?: string;
  /** Complete reviewed artifact closure; only pluginNames are enabled. */
  readonly packageSpecifiers?: readonly string[];
  readonly pluginNames?: readonly string[];
  readonly npmCommand?: string;
  readonly operation?: InstallerOperation;
  readonly restartController?: boolean;
}

export async function isPluginEnabled(name: string, pluginHome: string): Promise<boolean> {
  return (await readManifest(path.join(pluginHome, "plugins.json"))).plugins.includes(name);
}

export async function installPlugins(specifiers: readonly string[], options: InstallOptions): Promise<string[]> {
  if (specifiers.length === 0) throw new Error("at least one plugin package is required");
  for (const specifier of specifiers) {
    assertExactPluginSpecifier(specifier);
    if (packageNameFromSpecifier(specifier) === CONTROL_PLANE_RUNTIME) throw new Error("the control-plane runtime is not a plugin");
  }
  const currentDirectory = path.resolve(options.pluginHome);
  const managedRoot = path.dirname(currentDirectory);
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const restartController = options.target === "control-plane" ? false
    : options.restartController ?? await managedControllerIsActive(currentDirectory);
  const stagingDirectory = await mkdtemp(path.join(managedRoot, ".plugin-staging-"));
  const backupDirectory = path.join(managedRoot, `.plugin-previous-${process.pid}-${Date.now()}`);
  let previousMoved = false;
  let promoted = false;
  let controllerRestartAttempted = false;
  try {
    try {
      await cp(currentDirectory, stagingDirectory, { recursive: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    options.operation?.reportProgress("package installation");
    const installed = await installPluginsInStage(specifiers, options, stagingDirectory);
    options.operation?.reportProgress("runtime promotion");
    try {
      await rename(currentDirectory, backupDirectory);
      previousMoved = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await rename(stagingDirectory, currentDirectory);
    promoted = true;
    if (restartController) {
      controllerRestartAttempted = true;
      options.operation?.reportProgress("controller readiness");
      try {
        await run(
          path.join(currentDirectory, "node_modules", ".bin", "dim"),
          ["controller", "restart"],
          currentDirectory,
          options.operation
        );
      } catch (error) {
        throw new Error("target controller restart/readiness failed", { cause: error });
      }
    }
    await rm(backupDirectory, { recursive: true, force: true });
    return installed;
  } catch (error) {
    if (promoted) await rm(currentDirectory, { recursive: true, force: true });
    if (previousMoved) {
      await rename(backupDirectory, currentDirectory);
      if (controllerRestartAttempted) {
        options.operation?.activity();
        await run(
          path.join(currentDirectory, "node_modules", ".bin", "dim"),
          ["controller", "restart"],
          currentDirectory
        );
      }
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function installPluginsInStage(
  specifiers: readonly string[],
  options: InstallOptions,
  stagingDirectory: string
): Promise<string[]> {
  const packagePath = path.join(stagingDirectory, "package.json");
  const before = await readPackageJson(packagePath);
  if (!before) await writeFile(packagePath, `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600 });
  const runtime = options.target === "control-plane"
    ? options.runtimeSpecifier ?? `${CONTROL_PLANE_RUNTIME}@${await installerVersion()}` : undefined;
  if (runtime !== undefined) assertExactPluginSpecifier(runtime);
  const durableSpecifiers = await Promise.all([...(options.packageSpecifiers ?? [...specifiers, ...(runtime === undefined ? [] : [runtime])])]
    .map((specifier) => persistLocalSpecifier(specifier, stagingDirectory)));
  await run(
    options.npmCommand ?? "npm",
    ["install", "--save-exact", "--no-fund", "--no-audit", ...durableSpecifiers],
    stagingDirectory,
    options.operation
  );
  const after = await readPackageJson(packagePath);
  const dependencies = after?.dependencies ?? {};
  const previousDependencies = before?.dependencies ?? {};
  const added = Object.keys(dependencies).filter((name) => !(name in previousDependencies));
  const inferred = specifiers.map(packageNameFromSpecifier).filter((name): name is string => name !== undefined);
  const requestedArchives = new Set(options.packageSpecifiers === undefined
    ? specifiers.flatMap((specifier, index) => {
      const durable = durableSpecifiers[index];
      return specifier.endsWith(".tgz") && durable !== undefined ? [path.resolve(durable)] : [];
    }) : []);
  const archiveNames = Object.entries(dependencies).flatMap(([name, value]) => value.startsWith("file:")
    && requestedArchives.has(path.resolve(stagingDirectory, value.slice(5))) ? [name] : []);
  const installed = [...new Set(options.pluginNames ?? [...added, ...inferred, ...archiveNames])].filter((name) => name !== CONTROL_PLANE_RUNTIME);
  if (!installed.length) throw new Error("no plugin package was installed; the control-plane runtime is not a plugin");
  for (const name of installed) {
    if (!(name in dependencies)) throw new Error(`npm did not install '${name}' as a direct plugin dependency`);
  }
  for (const name of installed) await validatePluginTarget(stagingDirectory, name, options.target ?? "host");
  if (options.target === "control-plane") {
    if (!(CONTROL_PLANE_RUNTIME in dependencies)) throw new Error("control-plane runtime was not installed as a direct dependency");
    await assertControlPlaneClosure(stagingDirectory);
    await access(path.join(stagingDirectory, "node_modules", ".bin", "dim-control-plane"), constants.X_OK);
  }
  const manifestPath = path.join(stagingDirectory, "plugins.json");
  const manifest = await readManifest(manifestPath);
  const plugins = [...new Set([...manifest.plugins, ...installed])].sort();
  await atomicWrite(manifestPath, { schemaVersion: 1, plugins });
  return installed;
}

function assertExactPluginSpecifier(specifier: string): void {
  const candidate = specifier.startsWith("file:") ? specifier.slice(5) : specifier;
  if (candidate.endsWith(".tgz")) return;
  const packageName = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";
  const exactVersion = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
  if (!new RegExp(`^${packageName}@${exactVersion}$`).test(specifier)) {
    throw new Error(`plugin package '${specifier}' must use an exact version or a local .tgz archive`);
  }
}

export async function setPluginsEnabled(
  names: readonly string[],
  enabled: boolean,
  options: InstallOptions
): Promise<void> {
  if (names.length === 0) throw new Error("at least one plugin package is required");
  const dependencies = (await readPackageJson(path.join(options.pluginHome, "package.json")))?.dependencies ?? {};
  for (const name of names) {
    if (name === CONTROL_PLANE_RUNTIME) throw new Error("the control-plane runtime is not a plugin");
    if (!(name in dependencies)) throw new Error(`plugin '${name}' is not installed`);
  }
  if (enabled) for (const name of names) await validatePluginTarget(options.pluginHome, name, options.target ?? "host");
  const manifestPath = path.join(options.pluginHome, "plugins.json");
  const manifest = await readManifest(manifestPath);
  const selected = new Set(manifest.plugins);
  for (const name of names) enabled ? selected.add(name) : selected.delete(name);
  await atomicWrite(manifestPath, { schemaVersion: 1, plugins: [...selected].sort() });
}

export async function removePlugins(names: readonly string[], options: InstallOptions): Promise<void> {
  if (names.length === 0) throw new Error("at least one plugin package is required");
  const dependencies = (await readPackageJson(path.join(options.pluginHome, "package.json")))?.dependencies ?? {};
  for (const name of names) {
    if (name === CONTROL_PLANE_RUNTIME) throw new Error("the control-plane runtime is not a plugin");
    if (!(name in dependencies)) throw new Error(`plugin '${name}' is not installed`);
  }
  await run(options.npmCommand ?? "npm", ["uninstall", "--no-fund", "--no-audit", ...names], options.pluginHome);
  const manifestPath = path.join(options.pluginHome, "plugins.json");
  const manifest = await readManifest(manifestPath);
  const removed = new Set(names);
  await atomicWrite(manifestPath, {
    schemaVersion: 1,
    plugins: manifest.plugins.filter((name) => !removed.has(name)).sort()
  });
  await cleanupManagedSources(options.pluginHome);
}

export function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith("file:") || specifier.endsWith(".tgz")) return undefined;
  if (specifier.startsWith("@")) {
    const separator = specifier.indexOf("@", 1);
    return separator === -1 ? specifier : specifier.slice(0, separator);
  }
  if (/^[a-z0-9][a-z0-9._-]*(?:@.*)?$/.test(specifier)) return specifier.split("@", 1)[0];
  return undefined;
}

async function persistLocalSpecifier(specifier: string, pluginHome: string): Promise<string> {
  const candidate = specifier.startsWith("file:") ? specifier.slice(5) : specifier;
  if (!candidate.endsWith(".tgz")) return specifier;
  const source = path.resolve(candidate);
  await access(source, constants.R_OK);
  const digest = createHash("sha256").update(await readFile(source)).digest("hex");
  const sources = path.join(path.dirname(pluginHome), "sources");
  await mkdir(sources, { recursive: true, mode: 0o700 });
  const target = path.join(sources, `${digest}.tgz`);
  await copyFile(source, target);
  return target;
}

async function cleanupManagedSources(pluginHome: string): Promise<void> {
  const sources = path.join(path.dirname(pluginHome), "sources");
  const packageJson = await readPackageJson(path.join(pluginHome, "package.json"));
  const referenced = new Set(Object.values(packageJson?.dependencies ?? {}).flatMap((specifier) => {
    if (!specifier.startsWith("file:")) return [];
    return [path.resolve(pluginHome, specifier.slice(5))];
  }));
  let entries;
  try {
    entries = await readdir(sources, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.isFile() && !referenced.has(path.join(sources, entry.name)))
    .map((entry) => rm(path.join(sources, entry.name), { force: true })));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
