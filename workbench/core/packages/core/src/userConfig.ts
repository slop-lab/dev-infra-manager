import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";
import type { CiRunnerResources, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";

interface DimUserConfig {
  schemaVersion: 1;
  workspaceBackend?: WorkspaceRuntimeBackendKind;
  ciRunnerDefaults?: CiRunnerResources;
}

export function configuredCiRunnerDefaults(env: NodeJS.ProcessEnv = process.env): CiRunnerResources | undefined {
  const value = readUserConfig(env);
  if (value === undefined || value.ciRunnerDefaults === undefined) return undefined;
  return validateCiRunnerResources(value.ciRunnerDefaults, "ciRunnerDefaults");
}

export async function setConfiguredCiRunnerDefaults(
  resources: CiRunnerResources | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const target = dimUserConfigPath(env);
  const value = await readMutableUserConfig(target);
  if (resources === undefined) delete value.ciRunnerDefaults;
  else value.ciRunnerDefaults = validateCiRunnerResources(resources, "ciRunnerDefaults");
  await writeUserConfig(target, value);
  return target;
}

export function dimUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.resolve(
    env.DIM_CONFIG_PATH
      ?? path.join(configHome, "dim", "config.json")
  );
}

export function configuredWorkspaceBackend(
  env: NodeJS.ProcessEnv = process.env
): WorkspaceRuntimeBackendKind | undefined {
  const target = dimUserConfigPath(env);
  const value = readUserConfig(env);
  if (value === undefined) return undefined;
  if (value.schemaVersion !== 1) throw new UserError(`invalid DIM user config at ${target}`);
  if (value.workspaceBackend === undefined) return undefined;
  if (
    value.workspaceBackend !== "sysbox"
    && value.workspaceBackend !== "gvisor"
    && value.workspaceBackend !== "rootless-podman"
    && value.workspaceBackend !== "runc"
  ) {
    throw new UserError(`invalid workspaceBackend in DIM user config at ${target}`);
  }
  return value.workspaceBackend;
}

function readUserConfig(env: NodeJS.ProcessEnv): DimUserConfig | undefined {
  const target = dimUserConfigPath(env);
  try {
    const value = JSON.parse(readFileSync(target, "utf8")) as DimUserConfig;
    if (value.schemaVersion !== 1) throw new UserError(`invalid DIM user config at ${target}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof UserError) throw error;
    throw new UserError(`invalid DIM user config at ${target}`);
  }
}

export async function setConfiguredWorkspaceBackend(
  backend: WorkspaceRuntimeBackendKind,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const target = dimUserConfigPath(env);
  const value = await readMutableUserConfig(target);
  value.workspaceBackend = backend;
  await writeUserConfig(target, value);
  return target;
}

async function readMutableUserConfig(target: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw new UserError(`invalid DIM user config at ${target}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 };
    if (error instanceof UserError) throw error;
    throw new UserError(`invalid DIM user config at ${target}`);
  }
}

async function writeUserConfig(target: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validateCiRunnerResources(value: unknown, label: string): CiRunnerResources {
  if (!isRecord(value)) throw new UserError(`invalid ${label} in DIM user config`);
  const cpus = nonEmpty(value.cpus, `${label}.cpus`);
  const memory = nonEmpty(value.memory, `${label}.memory`);
  const pidsLimit = nonEmpty(value.pidsLimit, `${label}.pidsLimit`);
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(cpus) || Number(cpus) <= 0) throw new UserError(`invalid ${label}.cpus`);
  if (!/^[1-9][0-9]*(?:[kmgt]i?b?|[KMGT]i?B?)?$/.test(memory)) throw new UserError(`invalid ${label}.memory`);
  if (!/^[1-9][0-9]*$/.test(pidsLimit)) throw new UserError(`invalid ${label}.pidsLimit`);
  return { cpus, memory, pidsLimit };
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`invalid ${label}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
