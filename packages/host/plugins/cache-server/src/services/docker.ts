import type { CacheServiceDefinition, CacheEndpoint } from "../cache-services.js";
import type { CacheServiceAdapter } from "./types.js";

export const dockerService: CacheServiceAdapter = {
  kind: "docker",
  definition(image: string): CacheServiceDefinition {
    return { name: "docker", image, port: 5000, dataTarget: "/var/lib/registry", environment: {
      REGISTRY_PROXY_REMOTEURL: "https://registry-1.docker.io", REGISTRY_PROXY_TTL: "168h",
      REGISTRY_STORAGE_DELETE_ENABLED: "true", REGISTRY_LOG_LEVEL: "info", OTEL_TRACES_EXPORTER: "none"
    } };
  },
  endpointUrl: (endpoint: CacheEndpoint) => `http://${endpoint.host}:${endpoint.port}/`
};
