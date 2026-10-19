import { UserError } from "@slop-lab/dim-host-core";
import type { DimPluginHost } from "./plugin.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-host-core";

export const HOST_MIRROR_PROVIDER_EXTENSION = "dim.host-mirror-provider";
const HOST_MIRROR_PROVIDER_NAME = "host";

export type HostMirrorProvider = {
  ensure(runner: StreamingCommandRunner): Promise<import("../workspace/hostPlugin.js").HostExecutionRouting>;
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
