import type { CacheServiceDefinition, CacheEndpoint } from "../cache-services.js";
import type { CacheServiceAdapter } from "./types.js";

/** The default root/pypi mirror keeps wheel links in devpi's own cache namespace. */
export const pypiService: CacheServiceAdapter = {
  kind: "pypi",
  definition(image: string): CacheServiceDefinition {
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
  },
  endpointUrl: (endpoint: CacheEndpoint) => `http://${endpoint.host}:${endpoint.port}/root/pypi/+simple/`
};
