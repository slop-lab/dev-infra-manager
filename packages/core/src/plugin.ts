import { UserError } from "./errors.js";

export const DIM_PLUGIN_API_VERSION = 1 as const;

export interface DimPluginHost {}

export interface DimPlugin {
  readonly name: string;
  readonly apiVersion: typeof DIM_PLUGIN_API_VERSION;
  register(host: DimPluginHost): void | Promise<void>;
}

export async function registerPlugin(plugin: DimPlugin): Promise<void> {
  if (plugin.apiVersion !== DIM_PLUGIN_API_VERSION) {
    throw new UserError(
      `plugin '${plugin.name}' requires unsupported DIM plugin API ${String(plugin.apiVersion)}`
    );
  }
  await plugin.register({});
}
