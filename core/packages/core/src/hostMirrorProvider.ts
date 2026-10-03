import { UserError } from "./errors.js";
import type { DimPluginHost } from "./plugin.js";

export const HOST_MIRROR_PROVIDER_EXTENSION = "dim.host-mirror-provider";
const HOST_MIRROR_PROVIDER_NAME = "host";
const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-zA-Z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

export type HostMirrorProvider = {
  readonly dockerImage: string;
  readonly aptImage: string;
};

export function validateHostMirrorProvider(provider: object): HostMirrorProvider {
  if (!("dockerImage" in provider) || typeof provider.dockerImage !== "string"
    || !("aptImage" in provider) || typeof provider.aptImage !== "string"
    || !IMMUTABLE_IMAGE.test(provider.dockerImage) || !IMMUTABLE_IMAGE.test(provider.aptImage)) {
    throw new UserError("host mirror provider images must use an immutable digest");
  }
  return { dockerImage: provider.dockerImage, aptImage: provider.aptImage };
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

export function requireHostMirrorProvider(provider: HostMirrorProvider | undefined): HostMirrorProvider {
  if (provider === undefined) {
    throw new UserError("workspace and CI mirror routing requires one enabled host mirror provider");
  }
  return provider;
}
