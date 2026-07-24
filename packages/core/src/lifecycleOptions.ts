import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";
import type { LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";

export function lifecycleOptions(env: NodeJS.ProcessEnv = process.env): LifecycleOptions {
  return {
    stateRoot: path.resolve(env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim")),
    giteaImage: env.DIM_GITEA_IMAGE ?? "gitea/gitea:1.27.0",
    giteaPort: positiveInteger(env.DIM_GITEA_PORT ?? "3300", "DIM_GITEA_PORT"),
    giteaAdminUsername: env.DIM_GITEA_ADMIN_USERNAME ?? "dim-admin",
    gitUsername: env.DIM_GIT_USERNAME ?? "dim-workspace",
    defaultWorkspaceBackend: workspaceBackend(env.DIM_WORKSPACE_BACKEND ?? legacyBackend(env)),
    ...(env.DIM_WORKSPACE_IMAGE === undefined ? {} : { workspaceImage: env.DIM_WORKSPACE_IMAGE }),
    ...(env.DIM_WORKSPACE_RUNTIME === undefined ? {} : { workspaceRuntime: env.DIM_WORKSPACE_RUNTIME }),
    ...(env.DIM_WORKSPACE_PRIVILEGED === undefined ? {} : { workspacePrivileged: booleanValue(env.DIM_WORKSPACE_PRIVILEGED) }),
    cpuCount: env.DIM_WORKSPACE_CPUS ?? "2",
    memory: env.DIM_WORKSPACE_MEMORY ?? "4g",
    pidsLimit: env.DIM_WORKSPACE_PIDS ?? "2048"
  };
}

export function workspaceBackend(value: string): WorkspaceRuntimeBackendKind {
  if (value === "sysbox" || value === "gvisor" || value === "rootless-podman" || value === "runc") return value;
  throw new UserError("workspace backend must be sysbox, gvisor, rootless-podman, or runc");
}

function legacyBackend(env: NodeJS.ProcessEnv): string {
  if (booleanValue(env.DIM_WORKSPACE_PRIVILEGED)) return "runc";
  if (env.DIM_WORKSPACE_RUNTIME === "runsc") return "gvisor";
  if (env.DIM_WORKSPACE_RUNTIME === "runc") return "runc";
  return "sysbox";
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new UserError(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function booleanValue(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}
