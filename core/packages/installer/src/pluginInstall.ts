import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, readManifest, readPackageJson, run } from "./runtimeFiles.js";
import type { InstallerOperation } from "./installProgress.js";

export interface InstallOptions {
  readonly pluginHome: string;
  readonly npmCommand?: string;
  readonly operation?: InstallerOperation;
}

export async function isPluginEnabled(name: string, pluginHome: string): Promise<boolean> {
  return (await readManifest(path.join(pluginHome, "plugins.json"))).plugins.includes(name);
}

export async function installPlugins(specifiers: readonly string[], options: InstallOptions): Promise<string[]> {
  if (specifiers.length === 0) throw new Error("at least one plugin package is required");
  for (const specifier of specifiers) assertExactPluginSpecifier(specifier);
  const currentDirectory = path.resolve(options.pluginHome);
  const managedRoot = path.dirname(currentDirectory);
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
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
  const durableSpecifiers = await Promise.all(specifiers.map((specifier) => persistLocalSpecifier(specifier, stagingDirectory)));
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
  const installed = [...new Set([...added, ...inferred])];
  for (const name of installed) {
    if (!(name in dependencies)) throw new Error(`npm did not install '${name}' as a direct plugin dependency`);
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
    if (!(name in dependencies)) throw new Error(`plugin '${name}' is not installed`);
  }
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
