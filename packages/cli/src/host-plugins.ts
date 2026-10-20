import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ContainerWorkspaceRuntime, UserError, resolveHostPluginModule, type WorkspaceHostPlugin, type WorkspaceRuntime,
  type WorkspaceRuntimeFactoryContext, type HostExecutionRouting, type HostPluginExtension
} from "@slop-lab/dim-host-core/workspace";

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
  const plugins: WorkspaceHostPlugin[] = [];
  const names = new Set<string>(), commands = new Set<string>(), runtimes = new Set(["container"]), schemes = new Set<string>();
  for (const specifier of new Set<string>(raw.plugins)) {
    const module: unknown = await import(pathToFileURL(await resolveHostPluginModule(home, specifier)).href);
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
    for (const scheme of plugin.source?.schemes ?? []) {
      if (schemes.has(scheme)) throw new UserError(`duplicate workspace source scheme '${scheme}'`);
      schemes.add(scheme);
    }
    plugins.push(plugin);
  }
  hostPluginExtensions(plugins);
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
  if (value.extensions !== undefined && (!Array.isArray(value.extensions) || value.extensions.some((item: unknown) =>
    !isObject(item) || typeof item.kind !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(item.kind)
    || !identifier(item.name) || !isObject(item.value)))) throw new UserError(`invalid extensions in '${value.name}'`);
  if (value.source !== undefined) {
    const source = value.source;
    if (!isObject(source) || !Array.isArray(source.schemes) || source.schemes.length < 1 || source.schemes.length > 32
      || source.schemes.some((scheme: unknown) => typeof scheme !== "string" || !/^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) || ["http", "https", "ssh", "git", "file", "git+ssh", "ssh+git"].includes(scheme))
      || new Set(source.schemes).size !== source.schemes.length || typeof source.create !== "function"
      || source.ensure !== undefined && typeof source.ensure !== "function") throw new UserError(`invalid source provider in '${value.name}'`);
  }
  if (value.workspaceMetadata !== undefined && typeof value.workspaceMetadata !== "function") throw new UserError(`invalid workspace metadata provider in '${value.name}'`);
  if (value.executionRouting !== undefined && typeof value.executionRouting !== "function") throw new UserError(`invalid execution routing provider in '${value.name}'`);
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
      runtime = Promise.resolve(provider.create({ ...context, extensions: hostPluginExtensions(await installed()) })); providers.set(name, runtime);
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

/** Optional providers select actual configured routes, rather than claiming routing merely by installation. */
export async function resolveHostExecutionRouting(
  plugins: readonly WorkspaceHostPlugin[],
  context: WorkspaceRuntimeFactoryContext & { readonly signal: AbortSignal }
): Promise<HostExecutionRouting | undefined> {
  let selected: { name: string; routing: HostExecutionRouting } | undefined;
  const routingContext = { ...context, extensions: hostPluginExtensions(plugins) };
  for (const plugin of plugins) {
    const routing = await plugin.executionRouting?.(routingContext);
    if (routing === undefined) continue;
    if (selected) throw new UserError(`conflicting host execution routing providers '${selected.name}' and '${plugin.name}'`);
    selected = { name: plugin.name, routing };
  }
  return selected?.routing;
}

/** Duplicate contributions fail before any plugin hook executes. */
export function hostPluginExtensions(plugins: readonly WorkspaceHostPlugin[]): readonly HostPluginExtension[] {
  const result: HostPluginExtension[] = [], names = new Set<string>();
  for (const plugin of plugins) for (const extension of plugin.extensions ?? []) {
    const key = `${extension.kind}/${extension.name}`;
    if (names.has(key)) throw new UserError(`duplicate host plugin extension '${key}'`);
    names.add(key); result.push(extension);
  }
  return result;
}
