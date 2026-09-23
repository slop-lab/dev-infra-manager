import { readFile } from "node:fs/promises";
import path from "node:path";
import { type LifecycleOptions } from "@slop-lab/dim-core";
import { unixHttpRequest } from "./controller-transport.js";

export async function managedControllerReady(options: LifecycleOptions): Promise<boolean> {
  if (!await controllersHealthy(options)) return false;
  try {
    const value = await readFile(path.join(options.controllerRuntimeDirectory, "controller.pid"), "utf8");
    const pid = Number(value.trim());
    return Number.isSafeInteger(pid) && pid > 1 && processExists(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function controllersHealthy(options: LifecycleOptions): Promise<boolean> {
  return await controllerHealthy(options.controllerSocketPath)
    && await controllerHealthy(options.agentControllerSocketPath)
    && await controllerHealthy(options.adminControllerSocketPath);
}

export async function controllerHealthy(socketPath: string): Promise<boolean> {
  try {
    const response = await unixHttpRequest(socketPath, "/healthz", {}, undefined);
    return response.status === 200;
  } catch {
    return false;
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
