import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginTarget } from "./pluginInstall.js";

/** Installation executes only explicitly reviewed packages, never configure/start. */
export async function validatePluginTarget(home: string, name: string, target: PluginTarget): Promise<void> {
  const resolve = createRequire(path.join(home, "package.json"));
  const module: unknown = await import(pathToFileURL(resolve.resolve(name)).href);
  if (!record(module)) throw new Error(`plugin '${name}' has no module exports`);
  const descriptor = module.controlPlanePlugin;
  if (target === "control-plane") {
    if (!record(descriptor) || descriptor.apiVersion !== 1 || typeof descriptor.name !== "string"
      || !/^[a-z][a-z0-9-]{0,62}$/.test(descriptor.name) || typeof descriptor.configure !== "function") {
      throw new Error(`plugin '${name}' is not a control-plane plugin (expected controlPlanePlugin apiVersion 1); use install plugin for host plugins`);
    }
  } else if (descriptor !== undefined) {
    throw new Error(`plugin '${name}' belongs to the control plane; use install control-plane plugin`);
  }
}

/** Reject auto-installed peers as well as direct host-runtime dependencies. */
export async function assertControlPlaneClosure(home: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const location = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) { await visit(location); continue; }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (path.basename(directory) === "@slop-lab" && (["dim-host-core", "dim-cli", "dim-control-plane-admin"].includes(entry.name) || entry.name.startsWith("dim-host-plugin-"))) {
        throw new Error(`control-plane plugins must not install host runtime @slop-lab/${entry.name}`);
      }
      await visit(path.join(location, "node_modules"));
    }
  }
  await visit(path.join(home, "node_modules"));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
