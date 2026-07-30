import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";
import type { WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";

interface DimUserConfig {
  schemaVersion: 1;
  workspaceBackend?: WorkspaceRuntimeBackendKind;
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
  let value: DimUserConfig;
  try {
    value = JSON.parse(readFileSync(target, "utf8")) as DimUserConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UserError(`invalid DIM user config at ${target}`);
  }
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

export async function setConfiguredWorkspaceBackend(
  backend: WorkspaceRuntimeBackendKind,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const target = dimUserConfigPath(env);
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      throw new UserError(`invalid DIM user config at ${target}`);
    }
    value = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof UserError) throw error;
      throw new UserError(`invalid DIM user config at ${target}`);
    }
    value = { schemaVersion: 1 };
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...value, workspaceBackend: backend }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
