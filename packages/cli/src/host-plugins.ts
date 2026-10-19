import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ContainerWorkspaceRuntime, UserError, type WorkspaceHostPlugin, type WorkspaceRuntime,
  type WorkspaceRuntimeFactoryContext
} from "@slop-lab/dim-core/workspace";

/** Only explicitly installed host modules execute. Repository files never select host code. */
export function hostPluginHome(): string {
  return path.resolve(process.env.DIM_PLUGIN_HOME ?? path.join(
    process.env.DIM_DATA_HOME ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), "dim"),
    "runtime/current"
  ));
}

export async function loadHostPlugins(): Promise<readonly WorkspaceHostPlugin[]> {
  const home = hostPluginHome();
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8")); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.plugins)
    || !raw.plugins.every((value: unknown) => typeof value === "string" && value.length > 0)) {
    throw new UserError("invalid installed DIM plugin manifest");
  }
  const resolve = createRequire(path.join(home, "package.json"));
  const plugins: WorkspaceHostPlugin[] = [];
  const names = new Set<string>(), commands = new Set<string>(), runtimes = new Set(["container"]);
  for (const specifier of new Set<string>(raw.plugins)) {
    const module: unknown = await import(pathToFileURL(resolve.resolve(specifier)).href);
    if (!isObject(module) || module.hostPlugin === undefined) continue;
    const plugin = parseHostPlugin(module.hostPlugin);
    if (names.has(plugin.name)) throw new UserError(`duplicate host plugin '${plugin.name}'`);
    names.add(plugin.name);
    for (const command of plugin.commands ?? []) {
      if (commands.has(command.name)) throw new UserError(`duplicate host plugin command '${command.name}'`);
      commands.add(command.name);
    }
    if (plugin.runtime) {
      if (runtimes.has(plugin.runtime.name)) throw new UserError(`duplicate workspace runtime '${plugin.runtime.name}'`);
      runtimes.add(plugin.runtime.name);
    }
    plugins.push(plugin);
  }
  return plugins;
}

function parseHostPlugin(value: unknown): WorkspaceHostPlugin {
  if (!isObject(value) || !identifier(value.name)) throw new UserError("invalid host plugin name");
  if (value.runtime !== undefined && (!isObject(value.runtime) || !identifier(value.runtime.name)
    || (value.runtime.defaultImage !== undefined && (typeof value.runtime.defaultImage !== "string" || !value.runtime.defaultImage))
    || typeof value.runtime.create !== "function")) throw new UserError(`invalid runtime provider in '${value.name}'`);
  if (value.commands !== undefined && (!Array.isArray(value.commands) || value.commands.some((command: unknown) =>
    !isObject(command) || !identifier(command.name) || typeof command.description !== "string"))) {
    throw new UserError(`invalid commands in host plugin '${value.name}'`);
  }
  if (value.run !== undefined && typeof value.run !== "function") throw new UserError(`invalid command handler in '${value.name}'`);
  if (value.workspaceReady !== undefined && typeof value.workspaceReady !== "function") throw new UserError(`invalid workspace integration in '${value.name}'`);
  if (Array.isArray(value.commands) && value.commands.length && value.run === undefined) throw new UserError(`missing command handler in '${value.name}'`);
  if (value.guest !== undefined) {
    const guest = value.guest;
    if (!isObject(guest) || !description(guest.description)
      || (guest.inspect !== undefined && typeof guest.inspect !== "function")) throw new UserError(`invalid guest integration in '${value.name}'`);
    for (const key of ["commands", "operations"] as const) {
      const entries = guest[key];
      if (entries === undefined) continue;
      const names = new Set<string>();
      if (!Array.isArray(entries) || entries.length > 64) throw new UserError(`invalid guest ${key} in '${value.name}'`);
      for (const entry of entries as unknown[]) {
        if (!isObject(entry) || !identifier(entry.name) || !description(entry.description)
          || names.has(entry.name) || (key === "operations" && typeof entry.handle !== "function")) {
          throw new UserError(`invalid or duplicate guest ${key} in '${value.name}'`);
        }
        names.add(entry.name);
      }
    }
  }
  return value as unknown as WorkspaceHostPlugin;
}

/** Dispatch remains at host composition; the kernel knows only WorkspaceRuntime. */
export function composeWorkspaceRuntime(context: WorkspaceRuntimeFactoryContext): {
  runtime: WorkspaceRuntime;
  defaultImage(name: string): Promise<string | undefined>;
} {
  const container = new ContainerWorkspaceRuntime(context.runner, context.cleanupRunner);
  let plugins: Promise<readonly WorkspaceHostPlugin[]> | undefined;
  const providers = new Map<string, Promise<WorkspaceRuntime>>();
  const installed = () => plugins ??= loadHostPlugins();
  const get = async (name: string): Promise<WorkspaceRuntime> => {
    if (name === "container") return container;
    let runtime = providers.get(name);
    if (!runtime) {
      const provider = (await installed()).find((plugin) => plugin.runtime?.name === name)?.runtime;
      if (!provider) throw new UserError(`workspace runtime '${name}' is not installed; install its host plugin first`);
      runtime = Promise.resolve(provider.create(context)); providers.set(name, runtime);
    }
    return runtime;
  };
  return {
    async defaultImage(name) {
      if (name === "container") return undefined;
      const provider = (await installed()).find((plugin) => plugin.runtime?.name === name)?.runtime;
      if (!provider) throw new UserError(`workspace runtime '${name}' is not installed; install its host plugin first`);
      return provider.defaultImage;
    },
    runtime: {
      inspect: async (record) => (await get(record.runtime)).inspect(record),
      create: async (record) => (await get(record.runtime)).create(record),
      start: async (record) => (await get(record.runtime)).start(record),
      stop: async (record) => (await get(record.runtime)).stop(record),
      remove: async (record, options) => (await get(record.runtime)).remove(record, options),
      updateResources: async (record, resources) => (await get(record.runtime)).updateResources(record, resources),
      seed: async (record, directory) => (await get(record.runtime)).seed(record, directory),
      exec: async (record, command, options) => (await get(record.runtime)).exec(record, command, options),
      connect: async (record, port, options) => (await get(record.runtime)).connect(record, port, options),
      hostGateway: async (record) => {
        const runtime = await get(record.runtime);
        if (!runtime.hostGateway) throw new UserError(`workspace runtime '${record.runtime}' has no host service gateway`);
        return runtime.hostGateway(record);
      }
    }
  };
}

function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasCode(error: unknown, code: string): boolean { return isObject(error) && error.code === code; }

function description(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2000; }
