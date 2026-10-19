import type { CacheServiceDefinition } from "./cache-services.js";

/** Public npm metadata and tarballs only. Registry publishing has no enabled account. */
export function npmCacheDefinition(image: string): CacheServiceDefinition {
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
}

/** The default root/pypi mirror keeps wheel links in devpi's own cache namespace. */
export function pypiCacheDefinition(image: string): CacheServiceDefinition {
  return {
    name: "pypi", image, port: 3141, dataTarget: "/devpi/server",
    environment: { DEVPISERVER_SERVERDIR: "/devpi/server" },
    // No usable administrative credential enters host configuration or a guest.
    // The generated password is used once for initialization and then discarded.
    // Mirror reads remain public; client mutations are rejected by the relay.
    entrypoint: ["/bin/sh", "-ec"],
    command: [`if [ ! -f "$DEVPISERVER_SERVERDIR/.serverversion" ]; then
  devpi-init --serverdir "$DEVPISERVER_SERVERDIR" --root-passwd "$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
fi
exec devpi-server --serverdir "$DEVPISERVER_SERVERDIR" --host 0.0.0.0 --port 3141 --restrict-modify=root --request-timeout=15 --indexer-backend=null`]
  };
}
