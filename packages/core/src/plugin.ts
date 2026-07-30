import { UserError } from "./errors.js";
import type { DimControllerRoute } from "./controller.js";
import type { DimAdminRoute } from "./adminController.js";

export const DIM_PLUGIN_API_VERSION = 3 as const;

export interface HostInputRequest {
  readonly key: string;
  readonly parameters?: string;
}

export interface HostInputContext {
  readonly projectId: string;
  readonly projectName: string;
  readonly workspaceName: string;
}

export interface HostInputProvider {
  resolve(request: HostInputRequest, context: HostInputContext): Promise<string>;
}

export interface DimPluginLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface DimPluginHost {
  readonly apiVersion: typeof DIM_PLUGIN_API_VERSION;
  readonly logger: DimPluginLogger;
  registerControllerRoute(route: DimControllerRoute): void;
  registerAdminRoute(route: DimAdminRoute): void;
  registerHostInputProvider(name: string, provider: HostInputProvider): void;
  registerExtension(kind: string, name: string, extension: object): void;
  extension<T extends object>(kind: string, name: string): T | undefined;
}

export interface DimPlugin {
  readonly name: string;
  readonly apiVersion: typeof DIM_PLUGIN_API_VERSION;
  register(host: DimPluginHost): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface RegisteredDimPlugins {
  readonly host: DimPluginHost;
  readonly plugins: readonly string[];
  readonly controllerRoutes: readonly DimControllerRoute[];
  readonly adminRoutes: readonly DimAdminRoute[];
  readonly hostInputProviders: ReadonlyMap<string, HostInputProvider>;
  dispose(): Promise<void>;
}

class PluginHost implements DimPluginHost {
  readonly apiVersion = DIM_PLUGIN_API_VERSION;
  readonly routes: DimControllerRoute[] = [];
  readonly adminRoutes: DimAdminRoute[] = [];
  readonly providers = new Map<string, HostInputProvider>();
  readonly extensions = new Map<string, Map<string, object>>();
  registeringPlugin: string | undefined;
  acceptingRegistrations = true;

  constructor(readonly logger: DimPluginLogger) {}

  registerControllerRoute(route: DimControllerRoute): void {
    const plugin = this.registeringPlugin ?? "unknown plugin";
    if (!this.acceptingRegistrations) {
      throw new UserError(`plugin '${plugin}' attempted controller route registration after startup`);
    }
    if (!route || typeof route !== "object" || !["GET", "POST", "DELETE", "PUT", "PATCH"].includes(route.method)) {
      throw new UserError(`plugin '${plugin}' registered an invalid controller route method`);
    }
    if (!/^\/[a-z0-9][a-z0-9_/-]*(?:\/:[a-z][a-zA-Z0-9]*)?$/.test(route.path)) {
      throw new UserError(`plugin '${plugin}' registered invalid controller route path '${route.path}'`);
    }
    if (typeof route.handle !== "function") {
      throw new UserError(`plugin '${plugin}' registered controller route '${route.path}' without a handler`);
    }
    if (this.routes.some((existing) => existing.method === route.method && existing.path === route.path)) {
      throw new UserError(`controller route '${route.method} ${route.path}' is already registered`);
    }
    this.routes.push(Object.freeze({ ...route, plugin }));
  }

  registerAdminRoute(route: DimAdminRoute): void {
    const plugin = this.registeringPlugin ?? "unknown plugin";
    if (!this.acceptingRegistrations) {
      throw new UserError(`plugin '${plugin}' attempted admin route registration after startup`);
    }
    if (!route || typeof route !== "object" || !["GET", "POST", "DELETE", "PUT", "PATCH"].includes(route.method)) {
      throw new UserError(`plugin '${plugin}' registered an invalid admin route method`);
    }
    if (!/^\/[a-z0-9][a-z0-9_/-]*(?:\/:[a-z][a-zA-Z0-9]*)?$/.test(route.path)) {
      throw new UserError(`plugin '${plugin}' registered invalid admin route path '${route.path}'`);
    }
    if (typeof route.handle !== "function") {
      throw new UserError(`plugin '${plugin}' registered admin route '${route.path}' without a handler`);
    }
    if (this.adminRoutes.some((existing) => existing.method === route.method && existing.path === route.path)) {
      throw new UserError(`admin route '${route.method} ${route.path}' is already registered`);
    }
    this.adminRoutes.push(Object.freeze({ ...route, plugin }));
  }

  registerHostInputProvider(name: string, provider: HostInputProvider): void {
    const plugin = this.registeringPlugin ?? "unknown plugin";
    if (!this.acceptingRegistrations) {
      throw new UserError(`plugin '${plugin}' attempted host input provider registration after startup`);
    }
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) {
      throw new UserError(`plugin '${plugin}' registered invalid host input provider name '${name}'`);
    }
    if (!provider || typeof provider.resolve !== "function") {
      throw new UserError(`plugin '${plugin}' registered invalid host input provider '${name}'`);
    }
    if (this.providers.has(name)) throw new UserError(`host input provider '${name}' is already registered`);
    this.providers.set(name, provider);
  }

  registerExtension(kind: string, name: string, extension: object): void {
    const plugin = this.registeringPlugin ?? "unknown plugin";
    if (!this.acceptingRegistrations) {
      throw new UserError(`plugin '${plugin}' attempted extension registration after startup`);
    }
    if (!validExtensionName(kind) || !validExtensionName(name)) {
      throw new UserError(`plugin '${plugin}' registered invalid extension '${kind}/${name}'`);
    }
    if (!extension || typeof extension !== "object") {
      throw new UserError(`plugin '${plugin}' registered invalid extension '${kind}/${name}'`);
    }
    const values = this.extensions.get(kind) ?? new Map<string, object>();
    if (values.has(name)) throw new UserError(`extension '${kind}/${name}' is already registered`);
    values.set(name, Object.freeze(extension));
    this.extensions.set(kind, values);
  }

  extension<T extends object>(kind: string, name: string): T | undefined {
    return this.extensions.get(kind)?.get(name) as T | undefined;
  }
}

function validExtensionName(value: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*$/.test(value);
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
    host.acceptingRegistrations = false;
  }

  let disposed = false;
  return {
    host,
    plugins: [...names],
    controllerRoutes: [...host.routes],
    adminRoutes: [...host.adminRoutes],
    hostInputProviders: new Map(host.providers),
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await disposeReverse(disposers);
    }
  };
}

export async function registerPlugin(plugin: DimPlugin): Promise<RegisteredDimPlugins> {
  return registerPlugins([plugin]);
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
