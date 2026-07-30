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

An ingress is a host-approved external entry point backed by the plugin's
shared route registry. It combines:

- the public URL scheme and wildcard domain;
- the HTTP reverse-proxy listener;
- the target resolution mode; and
- the name and description shown to workspaces.

Ingresses are host resources shared by every workspace. `--argument` is an
opaque string owned and interpreted by the selected driver; DIM's common
contract does not add driver-specific JSON fields. Omitting it passes an empty
string, which the driver may accept as its default configuration or reject
with a driver-specific error. HTTP and HTTPS entry points are configured as
separate named ingresses:

```bash
dim external-url ingress add http --name local-http \
  --description "Local development URL" \
  --scheme http \
  --argument '{"domain":"dev.test","publicPort":8080,"listenHost":"0.0.0.0","listenPort":"auto"}'
```

The CLI sends provider and ingress requests to the plugin's admin API. The
controller atomically stores configuration in
`~/.config/dim/external-urls.json`; override its location with
`DIM_EXTERNAL_URL_CONFIG` in the managed controller environment.

`listenPort:"auto"` is resolved according to the selected driver's contract
and the selected number is persisted. For `http`, `listenHost` and
`listenPort` configure the DIM HTTP router. For `caddy`, they configure the
external HTTPS listener and therefore appear in returned URLs; its loopback
HTTP router is allocated and managed internally. The CLI restarts the managed
controller after ingress changes so drivers reload without recreating
workspaces.

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

The ingress returns the externally reachable URL. A request may provide any
relative DNS name with `--subdomain`. The default `workspace-prefix` route
policy accepts it only when it starts with `WORKSPACE--`; when omitted, DIM
assigns the first available `WORKSPACE--INDEX` name. An ingress may replace
that policy with a fail-closed webhook when shorter or shared names are
intentionally required.
Discarding a workspace revokes all its routes before its grant and state are
removed.

### Route policies

Every ingress defaults to the built-in `workspace-prefix` policy. The
authenticated workspace `dim-0` may request `dim-0--docs`, but not `docs` or
another workspace's prefix. This is a policy decision rather than a hostname
construction rule: the request carries the complete relative subdomain and
the shared registry checks the policy before reserving the resulting hostname.

Trusted installations may replace the default with an HTTP(S) or Unix-socket
webhook in the ingress argument:

```json
{
  "domain": "remote.example.com",
  "listenHost": "127.0.0.1",
  "listenPort": 8080,
  "routePolicy": {
    "driver": "webhook",
    "argument": "{\"url\":\"unix:/run/dim/policies/external-url.sock\"}"
  }
}
```

DIM sends `workspace.id`, `workspace.name`, `ingress`,
`requestedSubdomain`, and `domain`. The webhook returns
`{"allow":true}`, may return a replacement `subdomain`, or rejects with
`{"allow":false,"reason":"..."}`. DIM validates the final relative DNS name
and checks the complete hostname for conflicts. Errors, timeouts, malformed
responses, and non-2xx status codes fail closed. The policy cannot change the
target container or upstream address.

HTTP and Caddy listeners using the same domain share its hostname routes.
They must therefore configure the same route policy and upstream resolution
mode; DIM rejects ambiguous configurations at controller startup.

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

The plugin owns one shared route registry. One wildcard can expose it directly
over HTTP or through its built-in Caddy HTTPS frontend:

```text
http://*.remote.example.com:8080   → DIM router 0.0.0.0:8080 ─┐
https://*.remote.example.com:8443 → Caddy 100.64.0.10:8443   ├→ workspace target
                                   → managed loopback router ─┘
```

Configure the Cloudflare adapter and both ingresses:

```bash
dim external-url dns-provider add cloudflare \
  --name cloudflare-main \
  --argument "$(jq -cn --arg credential "$CF_API_TOKEN" '{credential:$credential}')"

dim external-url ingress add http --name public-http \
  --description "Public HTTP development URL" \
  --scheme http \
  --argument '{"domain":"remote.example.com","publicPort":8080,"listenHost":"0.0.0.0","listenPort":"auto"}'

dim external-url ingress add caddy --name public-https \
  --description "Public HTTPS development URL" \
  --scheme https \
  --argument '{"domain":"remote.example.com","listenHost":"100.64.0.10","listenPort":8443,"dnsProvider":"cloudflare-main","zone":"example.com","recordType":"A","target":"203.0.113.10","proxied":false}'

dim external-url ingress setup public-https
```

The Cloudflare DNS provider owns only its credential. The driver requires
`argument.credential` and stores it in the mode-`0600` External URL config.
`dns-provider list` does not return provider arguments. The Caddy
driver's `dnsProvider` field references that configured instance. Domain-bound
record policy (`zone`, `recordType`, `target`, and `proxied`) belongs to the
ingress argument, so one provider can serve multiple domains and ingresses.

Because the current config contains credentials, do not provide
`~/.config/dim/external-urls.json` to an AI agent or include it in diagnostics.
A separately managed secret store may replace this layout in a later version.

`ingress setup` idempotently creates or updates `*.remote.example.com` and writes
a pinned Caddy deployment under `.dim/external-url/public-https`. The
generated `.env` contains the stored credential and remains mode `0600`.
Start the deployment, then verify both DNS and HTTPS:

```bash
cd .dim/external-url/public-https
docker compose up --detach --build
dim external-url ingress verify public-https
```

Use a Cloudflare API Token accepted as a Bearer token, not a Global API Key,
restricted to the relevant zone with `Zone.Zone:Read` and `Zone.DNS:Edit`.
Caddy uses DNS-01 for wildcard certificate issuance and renewal.

Caddy uses host networking and binds only `listenHost:listenPort`; it does not
open an HTTP redirect port. In this example, open TCP 8080 for plain HTTP and
TCP/UDP 8443 for HTTPS and HTTP/3.

Removing an ingress preserves DNS by default. To verify and remove its
provider-managed wildcard record before deleting the local configuration:

```bash
dim external-url ingress remove public-https --cleanup-dns
```

## Plugin installation

Build the unpublished packages locally:

```bash
pnpm install --frozen-lockfile
bash scripts/pack-local-packages.bash /tmp/dim-packages
```

The directory contains every publishable package tarball plus `packages.json`,
which records the package name, version, and exact filename. This is also the
artifact directory to `COPY` into a container. Install the required tarballs
together so npm resolves unpublished DIM dependencies locally:

```dockerfile
COPY dim-packages /tmp/dim-packages
RUN npm install --global \
  /tmp/dim-packages/slop-lab-dim-core-*.tgz \
  /tmp/dim-packages/slop-lab-dim-cli-*.tgz
```

For external URLs, install the core, contract, DNS provider, and external-URL
plugin tarballs in the configured plugin home, list
`@slop-lab/dim-plugin-external-urls` in `plugins.json`, configure at least one
ingress with the CLI, and use a workspace command normally. DIM loads
installed plugins when it automatically starts the managed controller.
`dim controller serve --socket PATH` remains available for foreground
debugging.

Loading or listing the plugin before the first ingress exists succeeds and
does not create an empty config file. URL discovery and creation become useful
after `dim external-url ingress add`.

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
