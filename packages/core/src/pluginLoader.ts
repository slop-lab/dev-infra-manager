import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { UserError } from "./errors.js";
import { PluginRegistry, registerPlugin, type DimPlugin } from "./plugin.js";

export interface PluginManifest {
  schemaVersion: 1;
  plugins: string[];
}

export function pluginHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.DIM_PLUGIN_HOME
      ?? path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "dim", "plugins")
  );
}

export async function readPluginManifest(home = pluginHome()): Promise<PluginManifest> {
  try {
    const raw = JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8")) as unknown;
    if (
      typeof raw !== "object"
      || raw === null
      || (raw as { schemaVersion?: unknown }).schemaVersion !== 1
      || !Array.isArray((raw as { plugins?: unknown }).plugins)
      || !(raw as { plugins: unknown[] }).plugins.every((item) => typeof item === "string" && item.length > 0)
    ) {
      throw new UserError(`invalid DIM plugin manifest at ${path.join(home, "plugins.json")}`);
    }
    return {
      schemaVersion: 1,
      plugins: [...new Set((raw as { plugins: string[] }).plugins)]
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, plugins: [] };
    throw error;
  }
}

export async function loadInstalledPlugins(home = pluginHome()): Promise<{
  manifest: PluginManifest;
  registry: PluginRegistry;
}> {
  const manifest = await readPluginManifest(home);
  const registry = new PluginRegistry();
  const requireFromHome = createRequire(path.join(home, "package.json"));

  for (const specifier of manifest.plugins) {
    let resolved: string;
    try {
      resolved = requireFromHome.resolve(specifier);
    } catch (error) {
      throw new UserError(
        `installed DIM plugin '${specifier}' cannot be resolved from ${home}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const module = await import(pathToFileURL(resolved).href) as {
      default?: DimPlugin;
      plugin?: DimPlugin;
    };
    const plugin = module.default ?? module.plugin;
    if (!plugin) {
      throw new UserError(`DIM plugin '${specifier}' must export default or named 'plugin'`);
    }
    await registerPlugin(registry, plugin);
  }

  return { manifest, registry };
}

