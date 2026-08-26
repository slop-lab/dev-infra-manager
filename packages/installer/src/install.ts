import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export interface InstallOptions {
  pluginHome: string;
  npmCommand?: string;
}

export interface CliInstallOptions {
  version?: string;
  packageSpecifiers?: string[];
  packageNames?: string[];
  exposeOnPath: boolean;
  binDirectory?: string;
  configPath?: string;
  dataHome?: string;
  npmCommand?: string;
}

export interface LocalPackageBundle {
  packageSpecifiers: string[];
  packageNames: string[];
}

export interface InstalledCli {
  executable: string;
  mode: "direct" | "proxied";
  version: string;
  symlink?: string;
}

interface PluginManifest {
  schemaVersion: 1;
  plugins: string[];
}

interface DimCliConfig {
  mode: "direct" | "proxied";
  version: string;
  executable: string;
}

export interface DimUserConfig {
  schemaVersion: 1;
  installPrefix?: string;
  cli?: DimCliConfig;
  workspaceBackend?: "sysbox";
  [key: string]: unknown;
}

export function defaultUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.resolve(
    env.DIM_CONFIG_PATH
      ?? path.join(configHome, "dim", "config.json")
  );
}

export function defaultDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  return path.resolve(env.DIM_DATA_HOME ?? path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "dim"));
}

export function defaultPluginHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DIM_PLUGIN_HOME ?? path.join(defaultDataHome(env), "runtime", "current"));
}

export function defaultInstallPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DIM_INSTALL_PREFIX ?? path.join(env.HOME ?? os.homedir(), ".local"));
}

export function defaultBinDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultInstallPrefix(env), "bin");
}

export function cliExecutable(dataHome = defaultDataHome()): string {
  return path.join(path.resolve(dataHome), "runtime", "current", "node_modules", ".bin", "dim");
}

export async function configuredCli(env: NodeJS.ProcessEnv = process.env): Promise<DimCliConfig | undefined> {
  const config = await readUserConfig(defaultUserConfigPath(env));
  return config.cli;
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
  const previousManifest = await readManifest(path.join(currentDirectory, "plugins.json"));
  const previousPackage = await readPackageJson(path.join(currentDirectory, "package.json"));
  const providedNames = new Set(options.packageNames ?? []);
  const pluginSpecifiers = previousManifest.plugins.filter((name) => !providedNames.has(name)).map((name) => {
    const version = previousPackage?.dependencies?.[name];
    if (!version) throw new Error(`enabled plugin '${name}' is not installed in the DIM runtime`);
    return `${name}@${version}`;
  });
  const packageSpecifiers = [...requestedPackages, ...pluginSpecifiers];
  const configPath = options.configPath ?? defaultUserConfigPath();
  const backupDirectory = path.join(managedRoot, `.previous-${process.pid}-${Date.now()}`);
  let previousMoved = false;
  let promoted = false;
  let committed = false;
  let installedSymlink: string | undefined;
  try {
    await run(options.npmCommand ?? "npm", [
      "install", "--prefix", stagingDirectory, "--save-exact", "--no-fund", "--no-audit",
      ...packageSpecifiers
    ], stagingDirectory);
    const stagingExecutable = path.join(stagingDirectory, "node_modules", ".bin", "dim");
    await access(stagingExecutable, constants.X_OK);
    const installedVersion = await queryCliVersion(stagingExecutable);
    if (options.version && installedVersion !== options.version) {
      throw new Error(`installed DIM CLI reports ${installedVersion}, expected ${options.version}`);
    }
    await atomicWrite(path.join(stagingDirectory, "plugins.json"), previousManifest);

    try {
      await rename(currentDirectory, backupDirectory);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(stagingDirectory, currentDirectory);
    promoted = true;

    const executable = cliExecutable(dataHome);
    await access(executable, constants.X_OK);
    const mode = options.exposeOnPath ? "direct" : "proxied";
    if (options.exposeOnPath) {
      const binDirectory = path.resolve(options.binDirectory ?? defaultBinDirectory());
      installedSymlink = path.join(binDirectory, "dim");
      await installManagedSymlink(installedSymlink, executable, managedRoot);
    }
    const config = await readUserConfig(configPath);
    await writeUserConfig(configPath, {
      ...config,
      cli: { mode, version: installedVersion, executable }
    });
    committed = true;
    await cleanupRuntimeSiblings(managedRoot);
    return {
      executable,
      mode,
      version: installedVersion,
      ...(installedSymlink ? { symlink: installedSymlink } : {})
    };
  } catch (error) {
    if (!committed) {
      if (promoted) await rm(currentDirectory, { recursive: true, force: true });
      if (previousMoved) await rename(backupDirectory, currentDirectory);
      else if (installedSymlink) await unlink(installedSymlink).catch(() => undefined);
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

export async function readLocalPackageBundle(directory: string): Promise<LocalPackageBundle> {
  const bundleDirectory = path.resolve(directory);
  const manifestPath = path.join(bundleDirectory, "packages.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion?: unknown;
    packages?: Array<{ name?: unknown; file?: unknown }>;
  };
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.packages)) {
    throw new Error(`invalid local package bundle manifest: ${manifestPath}`);
  }

  const packages = raw.packages.filter((entry) => entry.name !== "@slop-lab/dim-installer");
  if (!packages.some((entry) => entry.name === "@slop-lab/dim-cli")) {
    throw new Error("local package bundle does not contain @slop-lab/dim-cli");
  }

  const names = new Set<string>();
  const packageSpecifiers: string[] = [];
  for (const entry of packages) {
    if (typeof entry.name !== "string" || typeof entry.file !== "string") {
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

  return {
    packageSpecifiers,
    packageNames: [...names]
  };
}

export async function installManagedSymlink(linkPath: string, target: string, managedRoot: string): Promise<void> {
  const absoluteLink = path.resolve(linkPath);
  const absoluteTarget = path.resolve(target);
  const absoluteManagedRoot = path.resolve(managedRoot);
  await mkdir(path.dirname(absoluteLink), { recursive: true, mode: 0o700 });

  try {
    const existing = await lstat(absoluteLink);
    if (!existing.isSymbolicLink()) {
      throw new Error(`${absoluteLink} already exists and is not managed by DIM installer`);
    }
    const rawTarget = await readlink(absoluteLink);
    const resolvedTarget = path.resolve(path.dirname(absoluteLink), rawTarget);
    if (!isWithin(resolvedTarget, absoluteManagedRoot)) {
      throw new Error(`${absoluteLink} already exists and is not managed by DIM installer`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = `${absoluteLink}.tmp-${process.pid}-${Date.now()}`;
  await symlink(absoluteTarget, temporary);
  try {
    await rename(temporary, absoluteLink);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function validateConfiguredCli(
  cli: DimCliConfig,
  facadePath: string | undefined
): Promise<string> {
  const executable = path.resolve(cli.executable);
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new Error(
      `DIM CLI ${cli.version} is configured at ${executable}, but it is not executable; run 'dim install-cli'`
    );
  }

  if (facadePath !== undefined) {
    try {
      if (await realpath(executable) === await realpath(facadePath)) {
        throw new Error("DIM CLI configuration points back to the installer facade");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return executable;
}

export async function queryCliVersion(executable: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${executable} --version exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

export async function installPlugins(specifiers: string[], options: InstallOptions): Promise<string[]> {
  if (specifiers.length === 0) throw new Error("at least one plugin package is required");
  await mkdir(options.pluginHome, { recursive: true, mode: 0o700 });
  const packagePath = path.join(options.pluginHome, "package.json");
  const before = await readPackageJson(packagePath);
  if (!before) {
    await writeFile(packagePath, `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600 });
  }

  const durableSpecifiers = await Promise.all(specifiers.map((specifier) => persistLocalSpecifier(specifier, options.pluginHome)));
  await run(options.npmCommand ?? "npm", [
    "install",
    "--save-exact",
    "--no-fund",
    "--no-audit",
    ...durableSpecifiers
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

export async function setPluginsEnabled(
  names: string[],
  enabled: boolean,
  options: InstallOptions
): Promise<void> {
  if (names.length === 0) throw new Error("at least one plugin package is required");
  const packageJson = await readPackageJson(path.join(options.pluginHome, "package.json"));
  const dependencies = packageJson?.dependencies ?? {};
  for (const name of names) {
    if (!(name in dependencies)) throw new Error(`plugin '${name}' is not installed`);
  }
  const manifestPath = path.join(options.pluginHome, "plugins.json");
  const manifest = await readManifest(manifestPath);
  const selected = new Set(manifest.plugins);
  for (const name of names) enabled ? selected.add(name) : selected.delete(name);
  await atomicWrite(manifestPath, { schemaVersion: 1, plugins: [...selected].sort() });
}

export async function removePlugins(names: string[], options: InstallOptions): Promise<void> {
  if (names.length === 0) throw new Error("at least one plugin package is required");
  const packageJson = await readPackageJson(path.join(options.pluginHome, "package.json"));
  const dependencies = packageJson?.dependencies ?? {};
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.isFile() && !referenced.has(path.join(sources, entry.name)))
    .map((entry) => rm(path.join(sources, entry.name), { force: true })));
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

export async function readUserConfig(target: string): Promise<DimUserConfig> {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as DimUserConfig;
    if (value.schemaVersion !== 1) throw new Error(`invalid DIM user config at ${target}`);
    if (value.cli !== undefined) validateCliConfig(value.cli, target);
    if (value.workspaceBackend !== undefined && value.workspaceBackend !== "sysbox") {
      throw new Error(`invalid workspaceBackend in DIM user config at ${target}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 };
    throw error;
  }
}

async function writeUserConfig(target: string, value: DimUserConfig): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await atomicWrite(target, { ...value, schemaVersion: 1 });
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

function validateCliConfig(value: unknown, target: string): asserts value is DimCliConfig {
  const cli = value as Partial<DimCliConfig>;
  if (
    typeof cli !== "object"
    || cli === null
    || (cli.mode !== "direct" && cli.mode !== "proxied")
    || typeof cli.version !== "string"
    || cli.version.length === 0
    || typeof cli.executable !== "string"
    || cli.executable.length === 0
  ) {
    throw new Error(`invalid cli configuration in DIM user config at ${target}`);
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
