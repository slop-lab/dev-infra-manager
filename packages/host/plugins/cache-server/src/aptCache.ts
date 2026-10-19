import type { CacheServiceDefinition } from "./cache-services.js";

export function aptCacheDefinition(image: string): CacheServiceDefinition {
  return { name: "apt", image, port: 3142, dataTarget: "/var/cache/apt-cacher-ng", environment: { DIM_HOST_MIRROR_RESOURCE: "apt-cache" } };
}
