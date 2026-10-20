import type { CacheEndpoint, CacheServiceDefinition } from "../cache-services.js";

export type CacheKind = "docker" | "npm" | "pypi" | "apt";

/** Reviewed backend code owns its process configuration and public URL layout. */
export interface CacheServiceAdapter {
  readonly kind: CacheKind;
  definition(image: string): CacheServiceDefinition;
  endpointUrl(endpoint: CacheEndpoint): string;
}
