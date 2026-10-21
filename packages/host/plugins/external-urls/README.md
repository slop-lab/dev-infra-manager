# `@slop-lab/dim-host-plugin-external-urls`

Workspace-scoped development endpoints for DIM. The plugin provides shared
direct HTTP ingresses, controller-managed Caddy HTTPS ingresses, and opt-in raw
TCP listeners, then routes each endpoint to a container or nested container
selected by the authenticated workspace.

This host plugin uses the controller in `@slop-lab/dim-host-core`. Install the
base runtime, then select the plugin. Its guest helpers are discovered and
delivered through the shared host integration mechanism.

## Installation

Install the plugin at the same exact version as DIM:

```bash
npx '@slop-lab/dim-installer@0.10.0' installer install plugin \
  '@slop-lab/dim-host-plugin-external-urls@0.10.0'
dim plugins
```

Restart the DIM host controller after changing installed plugins. Managed
wildcard certificate issuance requires a separately installed DNS provider such as
[`@slop-lab/dim-host-plugin-dns-cloudflare`](https://www.npmjs.com/package/@slop-lab/dim-host-plugin-dns-cloudflare).
Existing DNS and operator-managed wildcard certificates require no DNS plugin.

## Direct HTTP ingress

Configure a host-shared ingress:

```bash
dim external-url ingress add http \
  --name local-http \
  --description "Local development URLs" \
  --scheme http \
  --domain dev.test --public-port 8080 \
  --listen-host 0.0.0.0 --listen-port auto
```

Add `--require-approval` when each requested route must remain unreachable
until a host administrator runs `dim external-url approve URL_ID`. Requests
still succeed and return `pending`; `dim external-url revoke URL_ID` on the host
removes reachability terminally. Workspace-scoped plugin grants can revoke only
their own routes and cannot approve them. Revocation, route deletion, and
explicit route rebinding close active HTTP streams, WebSocket upgrades,
and TCP flows before removing or replacing the exact route claim. A change to
the stable external listener address or port returns approval to `pending`;
managed Caddy's ephemeral loopback router does not.

Then request a URL from a workspace:

```bash
dim external-url request \
  --workspace feature-123 \
  --ingress local-http \
  --container dev \
  --port 3000

dim external-url list --workspace feature-123
```

Named services use readable labels such as `dim-1--opencode` when the workspace
name is DNS-safe and the full label fits. Normalized or shortened workspace
names retain an identity suffix to avoid spelling collisions. Shared ingress
adds a host/workspace suffix only when another route already owns the name;
assigned alternate names remain stable on reconciliation.

HTTP and HTTPS requests return both a policy-selected `url` and a stable
`permalink`. The permalink authority has the form
`WORKSPACE-permalink-ROUTE_ID.DOMAIN`; it keeps the same route ID when a
same-instance policy change selects a new slug. Both authorities reserve
atomically, route to the same target, and share approval, rebinding, revocation,
and deletion. Recreating a discarded workspace creates a new route ID and
permalink. Raw TCP routes remain `tcp://ADDRESS:PORT` routes and return no
permalink.

On the host, omit `--workspace` to list routes for every current workspace.
That inventory includes workspace names and optional native Project names plus each route's approval
state, is capped at 1,000 routes,
and is available only through DIM's host-admin socket. Workspace-scoped
controller grants continue to list only their own workspace and cannot invoke
the host-wide action. Neither listing returns controller grants, provider
arguments, or credentials.

Targets address workspace loopback (`containers: []`) or one container in its
nested Docker engine (`containers: ["service-name"]`). The controller resolves
an owned in-agent relay; requests cannot supply an arbitrary host address.
Host sockets and credentials are never mounted into the workspace, and
ordinary Git workspaces require no Project metadata.

## Installed ingress plugins

HTTP and Caddy ingress are included. Additional host plugins contribute drivers
through `@slop-lab/dim-host-plugin-external-urls/plugin-api`, using
`externalUrlIngressDriverExtension(name, driver)`. Installing the
[Tailscale plugin](../tailscale/README.md) adds its explicit `tailscale` TCP
ingress driver; external-urls alone does not register it.

## Caddy HTTPS

The `caddy` ingress driver reconciles wildcard DNS, builds the required Caddy
DNS module, writes runtime files, and owns the Caddy container. Project
repositories do not deploy Caddy themselves. Configuration includes a named
DNS provider and that provider's opaque record argument.

If wildcard DNS already points to the ingress host, use the existing records and
a matching wildcard certificate instead. Paths refer to files on the selected
host, not inside the workspace:

```bash
dim external-url ingress add caddy \
  --name public --description "Existing development DNS" --scheme https \
  --domain dev.example.com --listen-host 0.0.0.0 --listen-port 443 \
  --tls-cert /etc/dim/tls/wildcard-fullchain.pem \
  --tls-key /etc/dim/tls/wildcard-key.pem
```

The certificate must cover `*.dev.example.com`; supply its PEM certificate chain
and matching unencrypted PEM key. DIM checks readability, validity dates, key
matching and wildcard coverage before starting Caddy. Only the trusted ingress
container receives these host files as read-only mounts. Workspace and agent
containers receive neither file nor private key. No DNS record is created,
modified or deleted, even with `ingress remove --cleanup-dns`. Renew these
certificates through your existing certificate management and restart the
controller after replacing them. Public clients still need to trust the issuer.
Do not combine `--tls-cert`/`--tls-key` with `--dns-provider`/`--dns-argument`.
HTTP ingress also works with existing wildcard DNS when TLS terminates at an
upstream ingress or when HTTP is suitable for the network.

The argument may also contain `staticRoutes`, for example
`[{"subdomain":"git","upstream":"http://127.0.0.1:3300"}]`. These exact
wildcard-domain hostnames route to host-reachable services before the dynamic
workspace router. The main External URLs documentation defines validation and
trust-boundary requirements.

For example, after configuring `cloudflare-main`:

```bash
dim external-url ingress add caddy \
  --name public \
  --description "Public development URLs" \
  --scheme https \
  --domain dev.example.com --listen-host 0.0.0.0 --listen-port 443 \
  --dns-provider cloudflare-main \
  --dns-argument '{"zone":"example.com","value":"203.0.113.10","proxied":false}' \
  --acme-email admin@example.com
```

Use `dim external-url ingress verify NAME` to verify DNS provider state and
HTTPS reachability. Removing an ingress does not delete DNS unless
`--cleanup-dns` is explicitly supplied.

## Policy and trust boundary

The default HTTP route policy requires workspace-qualified subdomains. An ingress
may instead use a fail-closed HTTP(S) or Unix-socket webhook to approve,
reject, or rewrite requested subdomains.

The controller stores active routes under DIM state and reconciles them on
restart. Each new HTTP request, WebSocket upgrade, and TCP connection checks the
current core workspace UUID and resolves its owned container and relay.
Saved routes also restore while their runtime is stopped or absent, and become
usable when that same workspace returns. A same-UUID container recreation
recovers on the next connection without a route
listing or controller restart. A missing or foreign runtime cannot receive
traffic through a cached IP. Discard or same-name replacement makes routes
unreachable immediately. DNS credentials remain in the
host's mode-`0600` configuration and are never returned through workspace
controller APIs.


See the complete
[External URLs guide](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/guides/external-urls.md),
[feature example](https://github.com/slop-lab/dev-infra-manager/tree/main/examples/features/external-urls),
and [source repository](https://github.com/slop-lab/dev-infra-manager).

## Coding agents

The package includes [the workspace URL skill](skills/external-urls/SKILL.md).
The installed host plugin automatically prepares `dim-expose` in each ready
workspace. No repository declaration is required. Run `dim-workspace plugins`
to discover its commands and whether the host has a configured ingress.
Inside a workspace, `dim-expose --name app --port 3000 --ingress NAME`
requests a route through the scoped guest API; `dim-expose list`
inspects its own routes. A pending route still needs host approval. This API
never provides host-admin credentials or allows another workspace selector.

## Ingress driver ownership

The package exports `ExternalUrlIngressDriver` and
`EXTERNAL_URL_INGRESS_DRIVER_EXTENSION`. Host controller plugins register a named
driver through that extension. Configuration, reload and verification resolve the
same selected driver; startup resolves it after all enabled plugins register, so
provider ordering does not change the stored ingress implementation. Missing
drivers fail startup instead of selecting another backend.

Each driver owns its argument parsing and runtime endpoint. Optional initialization,
removal, dependency and stale-resource hooks keep service lifecycle with the driver.
The Caddy implementation owns DNS reconciliation, secret environment files and
its Compose service; the common URL transport owns workspace routes, listeners
and approval checks. Failed initialization closes newly opened URL listeners.

The default route policy accepts the authenticated workspace prefix or an exact
`workspaceServiceSubdomain(workspaceName, serviceName)` label for any valid service.
This shared naming function is used by Web and workspace helpers alike; it
adds an identity hash only when normalization or shortening needs it, and does
not reserve a particular coding-agent name.
