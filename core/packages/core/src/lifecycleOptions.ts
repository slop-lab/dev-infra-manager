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
  const nativeConnectionFile = selectedAbsoluteFile(
    env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE,
    "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE"
  );
  const obsolete = ["DIM_GITEA_CONNECTION_FILE", "DIM_GIT_SYNC_CONNECTION_FILE",
    "DIM_QEMU_SCHEDULER_CONNECTION_FILE", "DIM_ORDINARY_CI_POOL_CONNECTION_FILE"]
    .find((name) => env[name] !== undefined);
  if (obsolete !== undefined) {
    throw new UserError(`${obsolete} is not supported by the native-only lifecycle`);
  }
  if (env.DIM_NATIVE_QEMU_CONNECTION_FILE !== undefined) {
    throw new UserError("native QEMU adapter is unavailable; refusing fallback");
  }
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
    ...(nativeConnectionFile === undefined
      ? {}
      : { nativeControlPlaneConnection: { file: nativeConnectionFile } }),
    defaultWorkspaceBackend,
    ...(env.DIM_WORKSPACE_IMAGE === undefined ? {} : { workspaceImage: env.DIM_WORKSPACE_IMAGE }),
    ...(env.DIM_WORKSPACE_RUNTIME === undefined ? {} : { workspaceRuntime: env.DIM_WORKSPACE_RUNTIME }),
    ...(env.DIM_WORKSPACE_PRIVILEGED === undefined ? {} : { workspacePrivileged: booleanValue(env.DIM_WORKSPACE_PRIVILEGED) }),
    cpuCount: env.DIM_WORKSPACE_CPUS ?? "2",
    memory: env.DIM_WORKSPACE_MEMORY ?? "4g",
    pidsLimit: env.DIM_WORKSPACE_PIDS ?? "2048",
    controllerRuntimeDirectory: controllerDirectory,
    controllerSocketPath: env.DIM_CONTROLLER_SOCKET
      ?? path.join(controllerDirectory, "workspace", "controller.sock"),
    agentControllerSocketPath: env.DIM_AGENT_CONTROLLER_SOCKET
      ?? path.join(controllerDirectory, "agent", "controller.sock"),
    adminControllerSocketPath: env.DIM_ADMIN_CONTROLLER_SOCKET
      ?? path.join(controllerDirectory, "admin", "controller.sock")
  };
}

export function requireNativeControlPlaneConnection(
  options: LifecycleOptions
): { readonly file: string } {
  if (options.nativeControlPlaneConnection === undefined) {
    throw new UserError(
      "native control plane is not configured; install the native control plane before modifying Projects or workspaces"
    );
  }
  return options.nativeControlPlaneConnection;
}

function selectedAbsoluteFile(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || !path.isAbsolute(value)) {
    throw new UserError(`${name} must name an absolute connection file`);
  }
  return value;
}

function booleanValue(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}
