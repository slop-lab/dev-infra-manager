# `@slop-lab/dim-plugin-external-urls`

Workspace-scoped development endpoints for DIM. The plugin provides shared
direct HTTP ingresses, controller-managed Caddy HTTPS ingresses, and opt-in raw
TCP listeners, then routes each endpoint to a container or nested container
selected by the authenticated workspace.

## Installation

Install the plugin at the same exact version as DIM:

```bash
npx '@slop-lab/dim-installer@0.9.0' install-plugin \
  '@slop-lab/dim-plugin-external-urls@0.9.0'
dim plugin list
```

Restart the managed DIM controller after changing installed plugins. A Caddy
HTTPS ingress also requires a separately installed DNS provider such as
[`@slop-lab/dim-plugin-dns-cloudflare`](https://www.npmjs.com/package/@slop-lab/dim-plugin-dns-cloudflare).

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
removes reachability terminally. Workspace and agent grants can revoke only
their own routes and cannot approve them. Revocation, route deletion, and
same-target runtime rebinding close active HTTP streams, WebSocket upgrades,
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

HTTP and HTTPS requests return both a policy-selected `url` and a stable
`permalink`. The permalink authority has the form
`WORKSPACE-permalink-ROUTE_ID.DOMAIN`; it keeps the same route ID when a
same-instance policy change selects a new slug. Both authorities reserve
atomically, route to the same target, and share approval, rebinding, revocation,
and deletion. Recreating a discarded workspace creates a new route ID and
permalink. Raw TCP routes remain `tcp://ADDRESS:PORT` routes and return no
permalink.

On the host, omit `--workspace` to list routes for every current workspace.
That inventory includes Project and workspace names plus each route's approval
state, is capped at 1,000 routes,
and is available only through DIM's host-admin socket. Workspace and agent
controller grants continue to list only their own workspace and cannot invoke
the host-wide action. Neither listing returns controller grants, provider
arguments, or credentials.

Targets may be the workspace root, one named child container, or a container
inside that child. DIM resolves the target through the workspace runtime
rather than accepting an arbitrary host address.

## Tailscale TCP ingress

The built-in `tailscale` driver exposes one raw TCP target through the DIM
host's existing Tailscale node. Tailscale must already be installed,
authenticated, and running on the host. Configuration is explicit and accepts
only a high listener port:

```bash
dim external-url ingress add tailscale \
  --name tailnet-ssh \
  --description "Tailnet SSH" \
  --scheme tcp --listen-port 49152

dim external-url request \
  --workspace feature-123 \
  --ingress tailnet-ssh \
  --container ssh --port 22 --protocol tcp
```

The driver runs only `tailscale status --json`, requires a running backend,
selects the current IPv4 address in `100.64.0.0/10`, and binds exactly that
address on a port from `49152` through `65535`. It does not run `tailscale up`,
depend on Serve or Funnel, or pass the Tailscale socket, state, credentials, or
binary into a workspace. One authenticated workspace target owns the listener
until its route is revoked; TCP requests do not accept URL paths. The listener
allows at most 256 concurrent flows, limits upstream connection setup to 10
seconds, and closes a flow after five idle minutes. Revocation, listener
shutdown, and a same-owner target refresh destroy both socket directions. A
refresh can therefore follow a recreated workspace address without allowing a
different workspace or logical target to take over the listener.

## Caddy HTTPS

The `caddy` ingress driver reconciles wildcard DNS, builds the required Caddy
DNS module, writes runtime files, and owns the Caddy container. Project
repositories do not deploy Caddy themselves. Configuration includes a named
DNS provider and that provider's opaque record argument.

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
restart. Workspace discard revokes its routes. DNS credentials remain in the
host's mode-`0600` configuration and are never returned through workspace
controller APIs.

For child development containers, expose only selected URL operations through
[`@slop-lab/dim-controller-proxy`](https://www.npmjs.com/package/@slop-lab/dim-controller-proxy);
never mount the original controller grant.

See the complete
[External URLs guide](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/external-urls.md),
[feature example](https://github.com/slop-lab/dev-infra-manager/tree/main/examples/features/external-urls),
and [source repository](https://github.com/slop-lab/dev-infra-manager).
