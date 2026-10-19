import { UserError } from "@slop-lab/dim-core";
import type { DimPluginHost } from "./plugin.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";

export const HOST_MIRROR_PROVIDER_EXTENSION = "dim.host-mirror-provider";
const HOST_MIRROR_PROVIDER_NAME = "host";
const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-zA-Z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

export type HostMirrorProvider = {
  readonly dockerImage: string;
  readonly aptImage: string;
  ensure(runner: StreamingCommandRunner): Promise<{
    readonly network: string; readonly dockerDaemonConfig: string;
    readonly blockedHostnames: readonly string[]; readonly aptEndpoint: string;
    readonly jobFiles?: readonly { readonly target: string; readonly contents: string }[];
  }>;
};

export function validateHostMirrorProvider(provider: object): HostMirrorProvider {
  if (!("dockerImage" in provider) || typeof provider.dockerImage !== "string"
    || !("aptImage" in provider) || typeof provider.aptImage !== "string"
    || !IMMUTABLE_IMAGE.test(provider.dockerImage) || !IMMUTABLE_IMAGE.test(provider.aptImage)) {
    throw new UserError("host mirror provider images must use an immutable digest");
  }
  if (!("ensure" in provider) || typeof provider.ensure !== "function") throw new UserError("host mirror provider must own cache service reconciliation");
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
