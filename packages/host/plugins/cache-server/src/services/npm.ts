import type { CacheServiceDefinition, CacheEndpoint } from "../cache-services.js";
import type { CacheServiceAdapter } from "./types.js";

/** Public npm metadata and tarballs only. Registry publishing has no enabled account. */
export const npmService: CacheServiceAdapter = {
  kind: "npm",
  definition(image: string): CacheServiceDefinition {
    return {
      name: "npm", image, port: 4873, dataTarget: "/verdaccio/storage",
      configFiles: [{ name: "config.yaml", target: "/verdaccio/conf/config.yaml", contents: `storage: /verdaccio/storage/data
auth:
  htpasswd:
    file: /verdaccio/storage/htpasswd
    max_users: -1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
    timeout: 5s
packages:
  '@*/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs
  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs
web:
  enable: false
middlewares:
  audit:
    enabled: false
listen: 0.0.0.0:4873
log: {type: stdout, format: json, level: warn}
` }]
    };
  },
  endpointUrl: (endpoint: CacheEndpoint) => `http://${endpoint.host}:${endpoint.port}/`
};
