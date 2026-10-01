import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, readManifest, readPackageJson, run } from "./runtimeFiles.js";

export interface InstallOptions {
  readonly pluginHome: string;
  readonly npmCommand?: string;
}

export async function installPlugins(specifiers: readonly string[], options: InstallOptions): Promise<string[]> {
  if (specifiers.length === 0) throw new Error("at least one plugin package is required");
  await mkdir(options.pluginHome, { recursive: true, mode: 0o700 });
  const packagePath = path.join(options.pluginHome, "package.json");
  const before = await readPackageJson(packagePath);
  if (!before) await writeFile(packagePath, `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600 });
  const durableSpecifiers = await Promise.all(specifiers.map((specifier) => persistLocalSpecifier(specifier, options.pluginHome)));
  await run(options.npmCommand ?? "npm", ["install", "--save-exact", "--no-fund", "--no-audit", ...durableSpecifiers], options.pluginHome);
  const after = await readPackageJson(packagePath);
  const dependencies = after?.dependencies ?? {};
  const previousDependencies = before?.dependencies ?? {};
  const added = Object.keys(dependencies).filter((name) => !(name in previousDependencies));
  const inferred = specifiers.map(packageNameFromSpecifier).filter((name): name is string => name !== undefined);
  const installed = [...new Set([...added, ...inferred])];
  for (const name of installed) {
    if (!(name in dependencies)) throw new Error(`npm did not install '${name}' as a direct plugin dependency`);
  }
  const manifestPath = path.join(options.pluginHome, "plugins.json");
  const manifest = await readManifest(manifestPath);
  const plugins = [...new Set([...manifest.plugins, ...installed])].sort();
  await atomicWrite(manifestPath, { schemaVersion: 1, plugins });
  return installed;
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
