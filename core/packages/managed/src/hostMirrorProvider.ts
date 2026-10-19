import { UserError } from "@slop-lab/dim-core";
import type { DimPluginHost } from "./plugin.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";

export const HOST_MIRROR_PROVIDER_EXTENSION = "dim.host-mirror-provider";
const HOST_MIRROR_PROVIDER_NAME = "host";

export type HostMirrorProvider = {
  ensure(runner: StreamingCommandRunner): Promise<{
    readonly network: string; readonly dockerDaemonConfig: string;
    readonly blockedHostnames: readonly string[];
    readonly jobFiles?: readonly { readonly target: string; readonly contents: string }[];
    readonly jobEnvironmentDefaults?: Readonly<Record<string, string>>;
  }>;
};

export function validateHostMirrorProvider(provider: object): HostMirrorProvider {
  if (!("ensure" in provider) || typeof provider.ensure !== "function") throw new UserError("host mirror provider must supply cache routing");
  return provider as HostMirrorProvider;
}

export function registerHostMirrorProvider(host: DimPluginHost, provider: HostMirrorProvider): void {
  host.registerExtension(
    HOST_MIRROR_PROVIDER_EXTENSION,
    HOST_MIRROR_PROVIDER_NAME,
    validateHostMirrorProvider(provider)
  );
}

export function resolveHostMirrorProvider(host: DimPluginHost): HostMirrorProvider | undefined {
  return host.extensionsOfKind<HostMirrorProvider>(HOST_MIRROR_PROVIDER_EXTENSION)[0];
}
