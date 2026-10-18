import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LifecycleOptions } from "./lifecycleTypes.js";

/** Managed Project state is separate from ordinary workspace state. */
export function managedStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DIM_MANAGED_STATE_ROOT ?? env.DIM_STATE_ROOT
    ?? path.join(env.HOME ?? os.homedir(), ".local/state/dim/managed"));
}

/** Optional host services resolve their own paths without selecting a workspace backend or Git service. */
export function lifecycleOptions(env: NodeJS.ProcessEnv = process.env): LifecycleOptions {
  const stateRoot = managedStateRoot(env);
  const defaultStateRoot = path.resolve(path.join(env.HOME ?? os.homedir(), ".local/state/dim/managed"));
  const runtimeRoot = path.join(env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `dim-${process.getuid?.() ?? "user"}`), "dim", "managed");
  const controllerDirectory = stateRoot === defaultStateRoot ? runtimeRoot
    : path.join(runtimeRoot, createHash("sha256").update(stateRoot).digest("hex").slice(0, 16));
  return {
    stateRoot, controllerRuntimeDirectory: controllerDirectory,
    controllerSocketPath: env.DIM_CONTROLLER_SOCKET ?? path.join(controllerDirectory, "workspace", "controller.sock"),
    adminControllerSocketPath: env.DIM_ADMIN_CONTROLLER_SOCKET ?? path.join(controllerDirectory, "admin", "controller.sock")
  };
}
