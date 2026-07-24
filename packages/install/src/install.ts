import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export interface InstallOptions {
  pluginHome: string;
  npmCommand?: string;
}

interface PluginManifest {
  schemaVersion: 1;
  plugins: string[];
}

export function defaultPluginHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.DIM_PLUGIN_HOME
      ?? path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "dim", "plugins")
  );
}

export async function installPlugins(specifiers: string[], options: InstallOptions): Promise<string[]> {
  if (specifiers.length === 0) throw new Error("at least one plugin package is required");
  await mkdir(options.pluginHome, { recursive: true, mode: 0o700 });
  const packagePath = path.join(options.pluginHome, "package.json");
  const before = await readPackageJson(packagePath);
  if (!before) {
    await writeFile(packagePath, `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600 });
  }

  await run(options.npmCommand ?? "npm", [
    "install",
    "--save-exact",
    "--no-fund",
    "--no-audit",
    ...specifiers
  ], options.pluginHome);

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

export function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith("@")) {
    const separator = specifier.indexOf("@", 1);
    return separator === -1 ? specifier : specifier.slice(0, separator);
  }
  if (/^[a-z0-9][a-z0-9._-]*(?:@.*)?$/.test(specifier)) {
    return specifier.split("@", 1)[0];
  }
  return undefined;
}

async function readPackageJson(target: string): Promise<{
  dependencies?: Record<string, string>;
} | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as { dependencies?: Record<string, string> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readManifest(target: string): Promise<PluginManifest> {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as PluginManifest;
    if (value.schemaVersion !== 1 || !Array.isArray(value.plugins)) {
      throw new Error(`invalid DIM plugin manifest at ${target}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, plugins: [] };
    throw error;
  }
}

async function atomicWrite(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

