import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWrite } from "./runtimeFiles.js";

export interface DimCliConfig {
  readonly mode: "direct" | "proxied";
  readonly version: string;
  readonly executable: string;
}

export interface DimUserConfig {
  readonly schemaVersion: 1;
  readonly installPrefix?: string;
  readonly cli?: DimCliConfig;
  readonly workspaceBackend?: "sysbox";
  readonly [key: string]: unknown;
}

export function defaultUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.resolve(env.DIM_CONFIG_PATH ?? path.join(configHome, "dim", "config.json"));
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

export async function readUserConfig(target: string): Promise<DimUserConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!isRecord(value) || value.schemaVersion !== 1) throw new Error(`invalid DIM user config at ${target}`);
    const { cli, schemaVersion: _schemaVersion, workspaceBackend, ...fields } = value;
    if (cli !== undefined) validateCliConfig(cli, target);
    if (workspaceBackend !== undefined && workspaceBackend !== "sysbox") {
      throw new Error(`invalid workspaceBackend in DIM user config at ${target}`);
    }
    return {
      ...fields,
      schemaVersion: 1,
      ...(cli === undefined ? {} : { cli }),
      ...(workspaceBackend === undefined ? {} : { workspaceBackend })
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { schemaVersion: 1 };
    throw error;
  }
}

export async function writeUserConfig(target: string, value: DimUserConfig): Promise<void> {
  await atomicWrite(target, { ...value, schemaVersion: 1 });
}

function validateCliConfig(value: unknown, target: string): asserts value is DimCliConfig {
  if (
    !isRecord(value)
    || (value.mode !== "direct" && value.mode !== "proxied")
    || typeof value.version !== "string"
    || value.version.length === 0
    || typeof value.executable !== "string"
    || value.executable.length === 0
  ) {
    throw new Error(`invalid cli configuration in DIM user config at ${target}`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
