import type { CacheServiceDefinition, CacheEndpoint } from "../cache-services.js";
import type { CacheServiceAdapter } from "./types.js";

export const aptService: CacheServiceAdapter = {
  kind: "apt",
  definition(image: string): CacheServiceDefinition {
    return { name: "apt", image, port: 3142, dataTarget: "/var/cache/apt-cacher-ng", environment: { DIM_HOST_MIRROR_RESOURCE: "apt-cache" } };
  },
  endpointUrl: (endpoint: CacheEndpoint) => `http://${endpoint.host}:${endpoint.port}/`
};
