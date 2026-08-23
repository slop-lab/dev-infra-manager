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
  return lifecycleOptionsForBackend(defaultWorkspaceBackend, env);
}

export function lifecycleOptionsForBackend(
  defaultWorkspaceBackend: LifecycleOptions["defaultWorkspaceBackend"],
  env: NodeJS.ProcessEnv = process.env
): LifecycleOptions {
  const stateRoot = path.resolve(env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim"));
  const defaultStateRoot = path.resolve(path.join(os.homedir(), ".local/state/dim"));
  const runtimeRoot = path.join(
    env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `dim-${process.getuid?.() ?? "user"}`),
    "dim"
  );
  const controllerDirectory = stateRoot === defaultStateRoot
    ? runtimeRoot
    : path.join(
      runtimeRoot,
      createHash("sha256").update(stateRoot).digest("hex").slice(0, 16)
    );
  return {
    stateRoot,
    giteaImage: env.DIM_GITEA_IMAGE ?? "gitea/gitea:1.27.0",
    giteaHost: env.DIM_GITEA_HOST ?? dockerHostName(env.DOCKER_HOST) ?? "127.0.0.1",
    giteaPort: positiveInteger(env.DIM_GITEA_PORT ?? "3300", "DIM_GITEA_PORT"),
    giteaAdminUsername: env.DIM_GITEA_ADMIN_USERNAME ?? "dim-admin",
    gitUsername: env.DIM_GIT_USERNAME ?? "dim-workspace",
    gitMaintainerUsername: env.DIM_GIT_MAINTAINER_USERNAME ?? "dim-host",
    defaultWorkspaceBackend,
    ...(env.DIM_WORKSPACE_IMAGE === undefined ? {} : { workspaceImage: env.DIM_WORKSPACE_IMAGE }),
    ...(env.DIM_WORKSPACE_RUNTIME === undefined ? {} : { workspaceRuntime: env.DIM_WORKSPACE_RUNTIME }),
    ...(env.DIM_WORKSPACE_PRIVILEGED === undefined ? {} : { workspacePrivileged: booleanValue(env.DIM_WORKSPACE_PRIVILEGED) }),
    cpuCount: env.DIM_WORKSPACE_CPUS ?? "2",
    memory: env.DIM_WORKSPACE_MEMORY ?? "4g",
    pidsLimit: env.DIM_WORKSPACE_PIDS ?? "2048",
    ciRunnerImage: env.DIM_CI_RUNNER_IMAGE
      ?? "gitea/act_runner@sha256:578925b4bdec5f60d93b5ba766cf02f2f9f32b1c8a4ec665ddf4d53d45f683c7",
    ciRunnerRuntime: env.DIM_CI_RUNNER_RUNTIME ?? "sysbox-runc",
    ciRunnerDefaultCpus: env.DIM_CI_RUNNER_CPUS ?? "4",
    ciRunnerDefaultMemory: env.DIM_CI_RUNNER_MEMORY ?? "8g",
    ciRunnerDefaultPidsLimit: env.DIM_CI_RUNNER_PIDS ?? "2048",
    controllerSocketPath: env.DIM_CONTROLLER_SOCKET
      ?? path.join(controllerDirectory, "controller.sock"),
    adminControllerSocketPath: env.DIM_ADMIN_CONTROLLER_SOCKET
      ?? path.join(controllerDirectory, "admin.sock")
  };
}

function dockerHostName(value: string | undefined): string | undefined {
  if (!value?.startsWith("tcp://")) return undefined;
  return new URL(value).hostname;
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
