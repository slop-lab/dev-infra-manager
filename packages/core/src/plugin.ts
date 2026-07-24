import { UserError } from "./errors.js";
import type { LifecycleOptions, RepoRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

export const DIM_PLUGIN_API_VERSION = 1 as const;

export interface RepositoryProviderContext {
  runner: StreamingCommandRunner;
  lifecycle: LifecycleOptions;
}

export interface RepositoryProviderRequest {
  name: string;
  source: string;
  protectedPatterns: string[];
  options?: Readonly<Record<string, unknown>>;
}

export interface RepositoryProvider {
  readonly kind: string;
  register(
    request: RepositoryProviderRequest,
    context: RepositoryProviderContext
  ): Promise<RepoRecord>;
}

export interface DimPluginHost {
  registerRepositoryProvider(provider: RepositoryProvider): void;
}

export interface DimPlugin {
  readonly name: string;
  readonly apiVersion: typeof DIM_PLUGIN_API_VERSION;
  register(host: DimPluginHost): void | Promise<void>;
}

export class PluginRegistry implements DimPluginHost {
  readonly #repositoryProviders = new Map<string, RepositoryProvider>();

  registerRepositoryProvider(provider: RepositoryProvider): void {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider.kind)) {
      throw new UserError(`repository provider kind '${provider.kind}' is invalid`);
    }
    if (this.#repositoryProviders.has(provider.kind)) {
      throw new UserError(`repository provider '${provider.kind}' is already registered`);
    }
    this.#repositoryProviders.set(provider.kind, provider);
  }

  repositoryProvider(kind: string): RepositoryProvider {
    const provider = this.#repositoryProviders.get(kind);
    if (!provider) throw new UserError(`repository provider '${kind}' is not installed`);
    return provider;
  }

  repositoryProviderKinds(): string[] {
    return [...this.#repositoryProviders.keys()].sort();
  }
}

export async function registerPlugin(registry: PluginRegistry, plugin: DimPlugin): Promise<void> {
  if (plugin.apiVersion !== DIM_PLUGIN_API_VERSION) {
    throw new UserError(
      `plugin '${plugin.name}' requires unsupported DIM plugin API ${String(plugin.apiVersion)}`
    );
  }
  await plugin.register(registry);
}

