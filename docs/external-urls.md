# External workspace URLs

DIM's external URL controller lets a workspace request an externally reachable
URL without letting the untrusted workspace select an arbitrary proxy
upstream. The workspace submits a service label and container port. The
controller authenticates the workspace grant and derives the upstream from the
workspace record.

## Contract

Every workspace receives:

```text
DIM_EXTERNAL_URLS_API=http://dim-controller:7070
DIM_EXTERNAL_URLS_TOKEN=<workspace-scoped grant>
```

List URLs:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_EXTERNAL_URLS_TOKEN" \
  "$DIM_EXTERNAL_URLS_API/api/external-urls/list"
```

Request URLs:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_EXTERNAL_URLS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"service":"web","port":3000,"urlProviders":["tailscale","cloudflare"]}' \
  "$DIM_EXTERNAL_URLS_API/api/external-urls/request"
```

The body accepts `service`, `port`, optional `protocol` (`http` or `https`),
optional absolute `path`, optional `routeProvider`, and optional
`urlProviders`. When multiple route providers are installed,
`routeProvider` is required. The response contains opaque URL IDs. Revoke one
with:

```bash
curl --fail --silent -X DELETE \
  -H "Authorization: Bearer $DIM_EXTERNAL_URLS_TOKEN" \
  "$DIM_EXTERNAL_URLS_API/api/external-urls/URL_ID"
```

The API never accepts an upstream hostname or IP. The built-in controller
resolves the target to the authenticated workspace's top-level container and
the requested port. A nested service must therefore publish its port onto the
top-level workspace container.

## Provider composition

External URL support is split into two plugin capabilities:

1. A route provider maps a controller-derived workspace upstream into a
   reverse proxy.
2. One or more URL providers publish names for that route.

The included `@slop-lab/dim-plugin-external-urls` package provides the
`reverse-proxy` route provider and the `tailscale` and `cloudflare` URL
providers. It forwards HTTP, HTTPS upstreams, streaming bodies, and WebSocket
upgrades.

Generated names use a unique first label:

```text
<service>--<workspace>.<tailscale-machine>.<user-domain>
<service>--<workspace>.<cloudflare-domain>
```

This permits any number of URLs per workspace, one or more DIM reverse proxies
per Tailscale machine, and a user-owned suffix whose wildcard records point at
tailnet IPs.

## Local build and installation

No registry publication is required:

```bash
pnpm install --frozen-lockfile
pnpm run workspace:build
npm pack ./packages/core/dist --pack-destination /tmp
npm pack ./packages/external-urls/dist --pack-destination /tmp
```

Install both generated tarballs into the controller's configured plugin home
with npm, then list the plugin package in `plugins.json`. The existing
`install-plugin` facade can also receive absolute tarball paths. Core and
plugin must come from the same checkout because the plugin API is currently
unstable.

## Controller

Run the trusted controller from the locally built CLI:

```bash
node packages/dim-cli/dist/cli.js controller serve --host 0.0.0.0 --port 7070
```

The process needs the DIM state directory and the installed plugin home. In a
container deployment, attach it to the `dim-control` network with the
`dim-controller` network alias. Do not expose port 7070 publicly.

The controller stores workspace grants under
`$DIM_STATE_ROOT/workspace-grants` and route journals under
`$DIM_STATE_ROOT/external-urls`, both with owner-only permissions. It
reconciles persisted reverse-proxy routes before accepting API traffic.

## Reverse proxy placement

A single listener is configured by:

```text
DIM_EXTERNAL_URL_PROXY_HOST=0.0.0.0
DIM_EXTERNAL_URL_PROXY_PORT=8080
DIM_EXTERNAL_URL_PROXY_PLACEMENT=controller
```

Placement defaults from the bind address: wildcard binds mean `controller`;
specific addresses mean `host`. `DIM_EXTERNAL_URL_PROXY_PLACEMENT` explicitly
overrides that inference.

To run host and controller listeners together, set a JSON array:

```json
[
  {
    "name": "reverse-proxy-host",
    "listenHost": "100.64.0.10",
    "listenPort": 8080,
    "placement": "host"
  },
  {
    "name": "reverse-proxy-controller",
    "listenHost": "0.0.0.0",
    "listenPort": 8081,
    "placement": "controller"
  }
]
```

Pass it as `DIM_EXTERNAL_URL_PROXIES`. The explicit `placement` fields are
optional overrides. Requests choose one with
`"routeProvider":"reverse-proxy-host"`. Separate controller processes may
instead run one listener each against the same durable DIM state.

## Tailscale

Configure:

```text
DIM_TAILSCALE_MACHINE=builder-1
DIM_TAILSCALE_DOMAIN=tail.example.com
DIM_TAILSCALE_SCHEME=https
```

Create wildcard DNS records for `*.builder-1.tail.example.com` pointing to the
Tailscale machine's tailnet IP. Run TLS termination (for example Caddy with a
DNS challenge certificate) in front of the plugin proxy when using `https`.

Two layouts are supported:

- Host Tailscale: run the controller/proxy on the host and bind the proxy to
  its tailnet IP.
- Controller Tailscale: give the trusted `dim-controller` container its own
  Tailscale identity and bind the proxy inside it.

Placement also selects upstream resolution: `controller` uses the workspace
container's Docker DNS name, while `host` inspects its address on the managed
Docker network. Tailscale identity and network-namespace provisioning remain
deployment concerns.

On a configured Tailnet, run the end-to-end smoke test from inside a DIM
workspace:

```bash
DIM_EXTERNAL_URL_TEST_ROUTE_PROVIDER=reverse-proxy-host \
  scripts/tailscale-external-url-smoke.sh
```

It starts a temporary HTTP service, requests a real Tailscale URL, fetches a
sentinel through DNS, TLS, and the reverse proxy, then revokes the URL. This
requires the operator's wildcard DNS and Tailnet, so it is intentionally
separate from the environment-independent unit suite.

## Cloudflare Tunnel

Configure:

```text
DIM_CLOUDFLARE_DOMAIN=workspaces.example.com
DIM_CLOUDFLARE_SCHEME=https
```

Configure a wildcard Cloudflare Tunnel hostname,
`*.workspaces.example.com`, to forward HTTP to the selected reverse-proxy
listener. Cloudflare terminates public TLS. The plugin deliberately does not
receive a Cloudflare API token: tunnel credentials stay in the separately
managed `cloudflared` runtime, while DIM only publishes deterministic URLs.

## Plugin API

Plugin API version 2 supplies an instance-scoped host. Plugins register typed
route and URL capabilities during `register(host)` and may return an async
disposer. Duplicate plugin and provider names fail startup. On partial startup
failure, already registered plugins are disposed in reverse order. Controller
processes retain the returned registry for their lifetime and dispose it on
shutdown.
