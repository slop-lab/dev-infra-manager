# External workspace URLs

DIM exposes one authenticated controller API that plugins extend. External
URLs are not a separate controller:

```text
GET    /api
GET    /api/urls
POST   /api/urls
DELETE /api/urls/:id
```

`GET /api` is the discovery entry point. It lists every installed plugin
route and the external URL profiles available to the authenticated workspace.

Every new workspace receives:

```text
DIM_CONTROLLER_API=http://host.docker.internal:7070
DIM_CONTROLLER_TOKEN=<workspace-scoped grant>
```

The workspace container gets a `host.docker.internal` host-gateway mapping.
Set `DIM_CONTROLLER_URL` on the host when the controller has another
workspace-reachable address.

## Host-owned profiles

The host defines the only profiles a workspace can request:

```text
DIM_EXTERNAL_URL_PROFILES={
  "tailscale": {
    "description": "Private development URL on the host tailnet",
    "protocol": "https"
  },
  "public": {
    "description": "Public preview URL",
    "protocol": "https"
  }
}
DIM_EXTERNAL_URL_BINDINGS={
  "tailscale": {
    "routeProvider": "reverse-proxy",
    "urlProvider": "tailscale"
  },
  "public": {
    "routeProvider": "cloudflare-proxy",
    "urlProvider": "cloudflare"
  }
}
```

Discovery reports only each profile's `name`, human-readable `description`,
and external URL `protocol` (`http` or `https`). Provider and proxy details
remain private host configuration. A workspace cannot provide raw provider
names, upstream hosts, IPs, or external hostname templates.

Tailscale is host-only. Internally, a profile backed by Tailscale must use a
host-reachable reverse proxy or controller startup fails. Tailscale is never
installed in a workspace, nested container, or controller container. Other
host-approved reverse proxies can run elsewhere; that implementation detail
can be mentioned in the profile description when it is useful to users.

## Discovery and requests

Discover profiles:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  "$DIM_CONTROLLER_API/api"
```

Create a URL:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "profile": "tailscale",
    "service": "web",
    "target": {
      "containers": ["dev"],
      "port": 3000,
      "protocol": "http"
    }
  }' \
  "$DIM_CONTROLLER_API/api/urls"
```

Targets are scoped to the authenticated workspace:

- `containers: []` addresses the project-root workspace container.
- `containers: ["dev"]` addresses a Compose service or named container in the
  workspace's nested engine.
- `containers: ["dev", "deep"]` addresses a container in `dev`'s nested
  engine. `deep` must publish the requested container port onto `dev`.

DIM resolves container identities itself. For nested targets it creates a TCP
relay inside the project-root container. A host proxy reaches the root
container's managed-network IP; a controller proxy uses Docker DNS.

List and revoke:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  "$DIM_CONTROLLER_API/api/urls"

curl --fail --silent -X DELETE \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  "$DIM_CONTROLLER_API/api/urls/URL_ID"
```

## Plugin and controller

Plugin API version 2 is instance-scoped. Plugins use
`registerControllerRoute()` to extend the DIM controller; core contains no
external-URL-specific controller or route prefix. Duplicate routes,
registration after startup, and unsupported API versions fail startup.
Plugins can initialize durable routes before the controller accepts traffic
and return an async disposer.

Build the unpublished packages locally:

```bash
pnpm install --frozen-lockfile
pnpm run workspace:build
npm pack ./packages/core/dist --pack-destination /tmp
npm pack ./packages/external-urls/dist --pack-destination /tmp
```

Install both tarballs in the configured plugin home, list
`@slop-lab/dim-plugin-external-urls` in `plugins.json`, then run:

```bash
dim controller serve --host 0.0.0.0 --port 7070
```

The controller port must be reachable by workspaces but must not be exposed
publicly.

## Tailscale host configuration

```text
DIM_TAILSCALE_MACHINE=builder-1
DIM_TAILSCALE_DOMAIN=tail.example.com
DIM_TAILSCALE_SCHEME=https
DIM_EXTERNAL_URL_PROXY_HOST=100.64.0.10
DIM_EXTERNAL_URL_PROXY_PORT=443
DIM_EXTERNAL_URL_PROXY_UPSTREAM_MODE=container-ip
```

Wildcard DNS for `*.builder-1.tail.example.com` points to the host's tailnet
IP. TLS termination may run in front of the plugin proxy.

## Cloudflare Tunnel

```text
DIM_CLOUDFLARE_DOMAIN=workspaces.example.com
DIM_CLOUDFLARE_SCHEME=https
```

Configure `*.workspaces.example.com` in Cloudflare Tunnel to forward to the
profile's reverse proxy. Tunnel credentials remain in the separately managed
`cloudflared` runtime; the DIM plugin receives no Cloudflare API token.

## Verification

[The external URL example](../examples/external-urls/README.md) and
`scripts/external-url-example-smoke.bash` verify:

```text
dnsmasq wildcard DNS
→ host reverse proxy
→ project-root relay
→ nested dev service
→ further nested container
```

The environment-independent unit suite also verifies controller discovery,
mandatory profile selection, target forwarding, HTTP proxying, revocation,
and Tailscale's host-only profile constraint. A configured real Tailnet can
run `scripts/tailscale-external-url-smoke.sh`.
