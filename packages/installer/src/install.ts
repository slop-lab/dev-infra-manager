import { access, lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export interface InstallOptions {
  pluginHome: string;
  configPath?: string;
  npmCommand?: string;
}

export interface CliInstallOptions {
  version: string;
  installationId?: string;
  packageSpecifiers?: string[];
  exposeOnPath: boolean;
  binDirectory?: string;
  configPath?: string;
  dataHome?: string;
  npmCommand?: string;
}

export interface LocalPackageBundle {
  version: string;
  installationId: string;
  packageSpecifiers: string[];
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
  pluginHome?: string;
  cli?: DimCliConfig;
  workspaceBackend?: "sysbox" | "gvisor" | "rootless-podman" | "runc";
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
  return path.resolve(env.DIM_PLUGIN_HOME ?? path.join(defaultDataHome(env), "plugins"));
}

export function defaultInstallPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DIM_INSTALL_PREFIX ?? path.join(env.HOME ?? os.homedir(), ".local"));
}

export function defaultBinDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultInstallPrefix(env), "bin");
}

export function cliVersionDirectory(version: string, dataHome = defaultDataHome()): string {
  return path.join(path.resolve(dataHome), "cli", version);
}

export function cliExecutable(version: string, dataHome = defaultDataHome()): string {
  return path.join(cliVersionDirectory(version, dataHome), "node_modules", ".bin", "dim");
}

export async function configuredPluginHome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const config = await readUserConfig(defaultUserConfigPath(env));
  return path.resolve(config.pluginHome ?? defaultPluginHome(env));
}

export async function configuredCli(env: NodeJS.ProcessEnv = process.env): Promise<DimCliConfig | undefined> {
  const config = await readUserConfig(defaultUserConfigPath(env));
  return config.cli;
}

export async function installDimCli(options: CliInstallOptions): Promise<InstalledCli> {
  const dataHome = path.resolve(options.dataHome ?? defaultDataHome());
  const versionDirectory = cliVersionDirectory(options.installationId ?? options.version, dataHome);
  await mkdir(versionDirectory, { recursive: true, mode: 0o700 });
  await run(options.npmCommand ?? "npm", [
    "install",
    "--prefix",
    versionDirectory,
    "--save-exact",
    "--no-fund",
    "--no-audit",
    ...(options.packageSpecifiers ?? [`@slop-lab/dim-cli@${options.version}`])
  ], versionDirectory);

  const executable = cliExecutable(options.installationId ?? options.version, dataHome);
  await access(executable, constants.X_OK);
  const installedVersion = await queryCliVersion(executable);
  if (installedVersion !== options.version) {
    throw new Error(`installed DIM CLI reports ${installedVersion}, expected ${options.version}`);
  }

  const mode = options.exposeOnPath ? "direct" : "proxied";
  let installedSymlink: string | undefined;
  if (options.exposeOnPath) {
    const binDirectory = path.resolve(options.binDirectory ?? defaultBinDirectory());
    installedSymlink = path.join(binDirectory, "dim");
    await installManagedSymlink(installedSymlink, executable, path.join(dataHome, "cli"));
  }

  const configPath = options.configPath ?? defaultUserConfigPath();
  const config = await readUserConfig(configPath);
  await writeUserConfig(configPath, {
    ...config,
    cli: {
      mode,
      version: options.version,
      executable: path.resolve(executable)
    },
    pluginHome: config.pluginHome ?? defaultPluginHome()
  });

  return {
    executable: path.resolve(executable),
    mode,
    version: options.version,
    ...(installedSymlink ? { symlink: installedSymlink } : {})
  };
}

export async function readLocalPackageBundle(directory: string): Promise<LocalPackageBundle> {
  const bundleDirectory = path.resolve(directory);
  const manifestPath = path.join(bundleDirectory, "packages.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion?: unknown;
    packages?: Array<{ name?: unknown; version?: unknown; file?: unknown }>;
  };
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.packages)) {
    throw new Error(`invalid local package bundle manifest: ${manifestPath}`);
  }

  const packages = raw.packages.filter((entry) => entry.name !== "@slop-lab/dim-installer");
  const cli = packages.find((entry) => entry.name === "@slop-lab/dim-cli");
  if (!cli || typeof cli.version !== "string" || cli.version.length === 0) {
    throw new Error("local package bundle does not contain @slop-lab/dim-cli");
  }

  const names = new Set<string>();
  const hash = createHash("sha256");
  const packageSpecifiers: string[] = [];
  for (const entry of packages) {
    if (typeof entry.name !== "string" || typeof entry.version !== "string" || typeof entry.file !== "string") {
      throw new Error(`invalid local package entry in ${manifestPath}`);
    }
    if (names.has(entry.name)) throw new Error(`duplicate local package '${entry.name}'`);
    names.add(entry.name);
    if (path.basename(entry.file) !== entry.file || !entry.file.endsWith(".tgz")) {
      throw new Error(`invalid local package filename '${entry.file}'`);
    }
    const tarball = path.join(bundleDirectory, entry.file);
    const contents = await readFile(tarball);
    hash.update(entry.name).update("\0").update(entry.version).update("\0").update(contents);
    packageSpecifiers.push(tarball);
  }

  return {
    version: cli.version,
    installationId: `local-${hash.digest("hex").slice(0, 16)}`,
    packageSpecifiers
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
  const configPath = options.configPath ?? defaultUserConfigPath();
  const config = await readUserConfig(configPath);
  await writeUserConfig(configPath, { ...config, pluginHome: path.resolve(options.pluginHome) });
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

export async function readUserConfig(target: string): Promise<DimUserConfig> {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as DimUserConfig;
    if (value.schemaVersion !== 1) throw new Error(`invalid DIM user config at ${target}`);
    if (value.cli !== undefined) validateCliConfig(value.cli, target);
    if (
      value.workspaceBackend !== undefined
      && value.workspaceBackend !== "sysbox"
      && value.workspaceBackend !== "gvisor"
      && value.workspaceBackend !== "rootless-podman"
      && value.workspaceBackend !== "runc"
    ) {
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
