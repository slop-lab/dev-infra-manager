# External workspace URLs

The external URL plugin extends two controller APIs. Host configuration uses
the host-only admin socket; workspace URL operations use the authenticated
workspace socket:

```text
POST   /v1/external-url/:action    # host administration

GET    /api
GET    /api/urls
POST   /api/urls
DELETE /api/urls/:id
```

DIM automatically starts and health-checks both sockets. The admin socket is
mode `0600` in the host state directory and is never mounted into a workspace.
Every workspace root receives only the workspace socket and its scoped grant:

```text
DIM_CONTROLLER_SOCKET=/run/dim/controller/controller.sock
DIM_CONTROLLER_TOKEN=<workspace-scoped grant>
```

The socket is mounted only into the trusted project-root container. Compose
services do not inherit either the socket or token unless reviewed `.dim`
code explicitly passes them through.

Do not pass the original socket and token into a development container.
The standard workspace image includes `dim-controller-proxy`; reviewed root
code can expose an ingress-restricted socket instead:

```bash
dim-controller-proxy external-url \
  --listen /run/dim/dev-controller/controller.sock \
  --ingress tailscale-main
```

Only the proxy socket directory is mounted into `dev`. The preset permits
filtered discovery, list, request, and individual revoke operations for the
named ingress and denies all other controller routes. Advanced reviewed policies use
`createControllerProxy` and `externalUrlProxy` from
`@slop-lab/dim-controller-proxy`; the runnable form is in the
[External URL example](../examples/external-urls/README.md).

## Named ingresses

An ingress is a host-approved external entry point. It combines:

- the public URL scheme and wildcard domain;
- the HTTP reverse-proxy listener;
- the target resolution mode; and
- the name and description shown to workspaces.

Ingresses are host resources shared by every workspace. `--argument` is an
opaque string owned and interpreted by the selected driver; DIM's common
contract does not add driver-specific JSON fields. HTTP and HTTPS entry points
are configured as separate named ingresses:

```bash
dim external-url ingress add builtin-http --name local-http \
  --description "Local development URL" \
  --scheme http \
  --argument '{"domain":"dev.test","publicPort":8080,"listenHost":"0.0.0.0","listenPort":"auto"}'
```

The CLI sends provider and ingress requests to the plugin's admin API. The
controller atomically stores configuration in
`~/.config/dim/external-urls.json`; override its location with
`DIM_EXTERNAL_URL_CONFIG` in the managed controller environment.

`listenPort:"auto"` is resolved by the driver to an available port and the
selected number is persisted. The CLI restarts the managed controller after
ingress changes so drivers reload without recreating workspaces.

`port` is the optional port placed in generated public URLs. `listenHost` and
`listenPort` select the plugin's internal HTTP router. For an HTTPS ingress,
Caddy or another TLS terminator listens publicly on port 443 and forwards the
original Host header to that internal router.

Discovery exposes only each ingress's `name`, `description`, and `scheme`.
Workspaces cannot select domains, listener addresses, upstream hosts, or
arbitrary provider configuration.

## Discovery and requests

Discover ingresses:

```bash
dim external-url discover
```

Create a URL:

```bash
dim external-url request --ingress public-https --container dev --port 3000
```

Targets are scoped to the authenticated workspace:

- `containers: []` addresses the project-root workspace container.
- `containers: ["dev"]` addresses a Compose service or named container in the
  workspace's nested engine.
- `containers: ["dev", "deep"]` addresses a container in `dev`'s nested
  engine. `deep` must publish the requested container port onto `dev`.

DIM resolves container identities itself. For nested targets it creates a TCP
relay inside the project-root container. An ingress using `container-ip`
reaches the root container's managed-network IP; `container-dns` is intended
for a router attached to the managed Docker network.

The ingress returns the externally reachable URL. Names use
`WORKSPACE--NAME` as the leftmost DNS label; `--name` rejects `--`. When the
name is omitted, the ingress assigns the first available numeric name.
Discarding a workspace revokes all its routes before its grant and state are
removed.

List and revoke:

```bash
dim external-url list --workspace WORKSPACE
dim external-url revoke URL_ID --workspace WORKSPACE
```

These `--workspace` forms are for occasional host-side administration. Normal
workspace use omits the option and automatically uses
`DIM_CONTROLLER_SOCKET` and `DIM_CONTROLLER_TOKEN`:

```bash
dim external-url list
dim external-url revoke URL_ID
```

## HTTP and HTTPS with Cloudflare DNS and Caddy

The system plugin is provider-agnostic. One wildcard can provide plain HTTP
through the built-in router and HTTPS through Caddy:

```text
http://*.remote.example.com:8080  → DIM router 0.0.0.0:8080 ─┐
https://*.remote.example.com     → Caddy :443               ├→ workspace target
                                  → DIM router 127.0.0.1:9080 ┘
```

Configure the Cloudflare adapter and both ingresses:

```bash
dim external-url add-provider cloudflare cloudflare-main \
  --zone example.com \
  --record-type A \
  --target 203.0.113.10 \
  --credential-env CF_API_TOKEN

dim external-url ingress add builtin-http --name public-http \
  --description "Public HTTP development URL" \
  --scheme http \
  --argument '{"domain":"remote.example.com","publicPort":8080,"listenHost":"0.0.0.0","listenPort":"auto"}'

dim external-url ingress add caddy --name public-https \
  --description "Public HTTPS development URL" \
  --scheme https \
  --argument '{"domain":"remote.example.com","listenHost":"127.0.0.1","listenPort":"auto","publicListenHost":"100.64.0.10","provider":"cloudflare-main"}'

CF_API_TOKEN=... dim external-url ingress setup public-https
```

`ingress setup` idempotently creates or updates `*.remote.example.com` and writes
a pinned Caddy deployment under `.dim/external-url/public-https`. The
Cloudflare adapter reads the token from the configured environment variable;
the token value is never stored in DIM configuration. Start the generated
deployment, then verify both DNS and HTTPS:

```bash
cd .dim/external-url/public-https
cp .env.example .env
docker compose up --detach --build
dim external-url ingress verify public-https
```

Use a Cloudflare API Token accepted as a Bearer token, not a Global API Key,
restricted to the relevant zone with `Zone.Zone:Read` and `Zone.DNS:Edit`.
Caddy uses DNS-01 for wildcard certificate issuance and renewal.

Caddy owns host ports 80 and 443; port 80 redirects to HTTPS. The distinct
plain HTTP ingress therefore uses port 8080 and generated HTTP URLs include
`:8080`. Open TCP 8080, TCP 80, TCP 443, and optionally UDP 443 for HTTP/3.

Removing an ingress preserves DNS by default. To verify and remove its
provider-managed wildcard record before deleting the local configuration:

```bash
dim external-url ingress remove public-https --cleanup-dns
```

## Plugin installation

Build the unpublished packages locally:

```bash
pnpm install --frozen-lockfile
pnpm run workspace:build
npm pack ./packages/core/dist --pack-destination /tmp
npm pack ./packages/contracts/external-url/dist --pack-destination /tmp
npm pack ./packages/plugin/external-urls/dist --pack-destination /tmp
```

Install the tarballs in the configured plugin home, list
`@slop-lab/dim-plugin-external-urls` in `plugins.json`, configure at least one
ingress with the CLI, and use a workspace command normally. DIM loads
installed plugins when it automatically starts the managed controller.
`dim controller serve --socket PATH` remains available for foreground
debugging.

Loading or listing the plugin before the first ingress exists succeeds with
an actionable warning and does not create an empty config file. URL discovery
and creation become useful after `dim external-url ingress add`.

## Verification

[The external URL example](../examples/external-urls/README.md) and
`scripts/external-url-example-smoke.bash` verify:

```text
dnsmasq wildcard DNS
→ named HTTP ingress
→ project-root relay
→ nested dev service
→ further nested container
```

The unit suite verifies ingress discovery, mandatory ingress selection,
multiple target-resolution modes, HTTP proxying, persistence, and revocation.
The example smoke test also runs a local Cloudflare-compatible API backed by
authoritative CoreDNS, then checks provider reconciliation, wildcard
resolution, and cleanup without external credentials.
A separately configured Tailnet ingress can run
`scripts/tailscale-external-url-smoke.sh`.
