import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UserError } from "@slop-lab/dim-host-core";
import { resolveHostPluginModule } from "../pluginModule.js";
import { DIM_PLUGIN_API_VERSION, registerPlugins, type DimPlugin, type RegisteredDimPlugins } from "./plugin.js";
import type { HostPluginExtension } from "../plugin-api.js";
import { builtInHostInputPlugin } from "./hostInputs.js";

export interface PluginManifest {
  schemaVersion: 1;
  plugins: string[];
}

export function pluginHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir();
  return path.resolve(
    env.DIM_PLUGIN_HOME
      ?? path.join(
        env.DIM_DATA_HOME ?? path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "dim"),
        "runtime",
        "current"
      )
  );
}

export async function resolvePluginHome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return pluginHome(env);
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
  registered: RegisteredDimPlugins;
}> {
  const manifest = await readPluginManifest(home);
  const plugins: DimPlugin[] = [];

  for (const specifier of manifest.plugins) {
    let resolved: string;
    try {
      resolved = await resolveHostPluginModule(home, specifier);
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
      hostPlugin?: unknown;
    };
    const contributions = hostExtensions(module.hostPlugin, specifier);
    if (contributions.length) plugins.push({
      name: `${specifier}:host-extensions`, apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) { for (const extension of contributions) host.registerExtension(extension.kind, extension.name, extension.value); }
    });
    const plugin = module.default ?? module.plugin;
    // Host-only integrations are consumed by the selected host CLI. Their
    // installation must not make an optional controller load another runtime.
    if (!plugin && module.hostPlugin !== undefined) continue;
    if (!plugin) {
      throw new UserError(`DIM plugin '${specifier}' must export default or named 'plugin'`);
    }
    plugins.push(plugin);
  }

  return { manifest, registered: await registerPlugins([builtInHostInputPlugin, ...plugins]) };
}

function hostExtensions(raw: unknown, specifier: string): readonly HostPluginExtension[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UserError(`invalid host plugin export: ${specifier}`);
  const extensions: unknown = Reflect.get(raw, "extensions");
  if (extensions === undefined) return [];
  if (!Array.isArray(extensions)) throw new UserError(`invalid host plugin extensions: ${specifier}`);
  return extensions.map((raw: unknown): HostPluginExtension => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UserError(`invalid host plugin extension: ${specifier}`);
    const kind: unknown = Reflect.get(raw, "kind"), name: unknown = Reflect.get(raw, "name"), value: unknown = Reflect.get(raw, "value");
    if (typeof kind !== "string" || !kind || typeof name !== "string" || !name || !value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`invalid host plugin extension: ${specifier}`);
    return { kind, name, value };
  });
}
