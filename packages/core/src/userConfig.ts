import { readFileSync } from "node:fs";
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
