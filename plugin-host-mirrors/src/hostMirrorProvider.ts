import { UserError } from "@slop-lab/dim-core";

export interface HostMirrorImages { readonly dockerImage: string; readonly aptImage: string }
export function requireHostMirrorProvider(provider: HostMirrorImages | undefined): HostMirrorImages {
  if (!provider) throw new UserError("mirror service images must be selected by the installed host plugin");
  return provider;
}
