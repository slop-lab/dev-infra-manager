import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { UserError } from "./errors.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import { configuredWorkspaceBackend } from "./userConfig.js";

export function lifecycleOptions(env: NodeJS.ProcessEnv = process.env): LifecycleOptions {
  const defaultWorkspaceBackend = configuredWorkspaceBackend(env);
  if (defaultWorkspaceBackend === undefined) {
    throw new UserError(
      `workspace backend is not configured in DIM user config; install a host backend first`
    );
  }
  return {
    stateRoot: path.resolve(env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim")),
    giteaImage: env.DIM_GITEA_IMAGE ?? "gitea/gitea:1.27.0",
    giteaPort: positiveInteger(env.DIM_GITEA_PORT ?? "3300", "DIM_GITEA_PORT"),
    giteaAdminUsername: env.DIM_GITEA_ADMIN_USERNAME ?? "dim-admin",
    gitUsername: env.DIM_GIT_USERNAME ?? "dim-workspace",
    defaultWorkspaceBackend,
    ...(env.DIM_WORKSPACE_IMAGE === undefined ? {} : { workspaceImage: env.DIM_WORKSPACE_IMAGE }),
    ...(env.DIM_WORKSPACE_RUNTIME === undefined ? {} : { workspaceRuntime: env.DIM_WORKSPACE_RUNTIME }),
    ...(env.DIM_WORKSPACE_PRIVILEGED === undefined ? {} : { workspacePrivileged: booleanValue(env.DIM_WORKSPACE_PRIVILEGED) }),
    cpuCount: env.DIM_WORKSPACE_CPUS ?? "2",
    memory: env.DIM_WORKSPACE_MEMORY ?? "4g",
    pidsLimit: env.DIM_WORKSPACE_PIDS ?? "2048",
    controllerSocketPath: env.DIM_CONTROLLER_SOCKET
      ?? path.join(
        env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `dim-${process.getuid?.() ?? "user"}`),
        "dim",
        createHash("sha256")
          .update(path.resolve(env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim")))
          .digest("hex")
          .slice(0, 16),
        "controller.sock"
      )
  };
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
