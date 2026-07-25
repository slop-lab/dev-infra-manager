import { UserError } from "./errors.js";
import type { ExternalRouteProvider, ExternalUrlProvider } from "./externalUrls.js";

export const DIM_PLUGIN_API_VERSION = 2 as const;

export interface DimPluginLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface DimPluginHost {
  readonly apiVersion: typeof DIM_PLUGIN_API_VERSION;
  readonly logger: DimPluginLogger;
  registerExternalRouteProvider(provider: ExternalRouteProvider): void;
  registerExternalUrlProvider(provider: ExternalUrlProvider): void;
}

export interface DimPlugin {
  readonly name: string;
  readonly apiVersion: typeof DIM_PLUGIN_API_VERSION;
  register(host: DimPluginHost): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface RegisteredDimPlugins {
  readonly host: DimPluginHost;
  readonly plugins: readonly string[];
  readonly externalRouteProviders: ReadonlyMap<string, ExternalRouteProvider>;
  readonly externalUrlProviders: ReadonlyMap<string, ExternalUrlProvider>;
  dispose(): Promise<void>;
}

class PluginHost implements DimPluginHost {
  readonly apiVersion = DIM_PLUGIN_API_VERSION;
  readonly externalRouteProviders = new Map<string, ExternalRouteProvider>();
  readonly externalUrlProviders = new Map<string, ExternalUrlProvider>();
  registeringPlugin: string | undefined;

  constructor(readonly logger: DimPluginLogger) {}

  registerExternalRouteProvider(provider: ExternalRouteProvider): void {
    this.registerProvider(this.externalRouteProviders, provider, "external route");
  }

  registerExternalUrlProvider(provider: ExternalUrlProvider): void {
    this.registerProvider(this.externalUrlProviders, provider, "external URL");
  }

  private registerProvider<T extends { name: string }>(providers: Map<string, T>, provider: T, kind: string): void {
    const plugin = this.registeringPlugin ?? "unknown plugin";
    if (!/^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(provider.name)) {
      throw new UserError(`plugin '${plugin}' registered invalid ${kind} provider name '${provider.name}'`);
    }
    if (providers.has(provider.name)) {
      throw new UserError(`${kind} provider '${provider.name}' is already registered`);
    }
    providers.set(provider.name, provider);
  }
}

const consoleLogger: DimPluginLogger = {
  debug: (message, fields) => console.debug(message, fields ?? ""),
  info: (message, fields) => console.info(message, fields ?? ""),
  warn: (message, fields) => console.warn(message, fields ?? ""),
  error: (message, fields) => console.error(message, fields ?? "")
};

export async function registerPlugins(
  plugins: readonly DimPlugin[],
  options: { logger?: DimPluginLogger } = {}
): Promise<RegisteredDimPlugins> {
  const host = new PluginHost(options.logger ?? consoleLogger);
  const names = new Set<string>();
  const disposers: Array<() => void | Promise<void>> = [];

  try {
    for (const plugin of plugins) {
      validatePlugin(plugin);
      if (names.has(plugin.name)) throw new UserError(`DIM plugin '${plugin.name}' is already registered`);
      names.add(plugin.name);
      host.registeringPlugin = plugin.name;
      const dispose = await plugin.register(host);
      if (dispose !== undefined) disposers.push(dispose);
    }
  } catch (error) {
    await disposeReverse(disposers);
    throw error;
  } finally {
    host.registeringPlugin = undefined;
  }

  let disposed = false;
  return {
    host,
    plugins: [...names],
    externalRouteProviders: host.externalRouteProviders,
    externalUrlProviders: host.externalUrlProviders,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await disposeReverse(disposers);
    }
  };
}

export async function registerPlugin(plugin: DimPlugin): Promise<void> {
  await registerPlugins([plugin]);
}

function validatePlugin(plugin: DimPlugin): void {
  if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string" || plugin.name.length === 0) {
    throw new UserError("DIM plugin must have a non-empty name");
  }
  if (plugin.apiVersion !== DIM_PLUGIN_API_VERSION) {
    throw new UserError(
      `plugin '${plugin.name}' requires unsupported DIM plugin API ${String(plugin.apiVersion)}`
    );
  }
  if (typeof plugin.register !== "function") {
    throw new UserError(`plugin '${plugin.name}' must provide register(host)`);
  }
}

async function disposeReverse(disposers: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "one or more DIM plugins failed to dispose");
}
