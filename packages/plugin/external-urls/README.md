# `@slop-lab/dim-plugin-external-urls`

Workspace-scoped development URLs for DIM. The plugin provides shared direct
HTTP ingresses and controller-managed Caddy HTTPS ingresses, then routes each
URL to a container or nested container selected by the authenticated
workspace.

## Installation

Install the plugin at the same exact version as DIM:

```bash
npx '@slop-lab/dim-installer@0.6.0' install-plugin \
  '@slop-lab/dim-plugin-external-urls@0.6.0'
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
  --argument \
  '{"domain":"dev.test","publicPort":8080,"listenHost":"0.0.0.0","listenPort":"auto"}'
```

Then request a URL from a workspace:

```bash
dim external-url request \
  --workspace feature-123 \
  --ingress local-http \
  --container dev \
  --port 3000

dim external-url list --workspace feature-123
```

Targets may be the workspace root, one named child container, or a container
inside that child. DIM resolves the target through the workspace runtime
rather than accepting an arbitrary host address.

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
  --argument \
  '{"domain":"dev.example.com","listenHost":"0.0.0.0","listenPort":443,"dnsProvider":"cloudflare-main","dnsArgument":"{\"zone\":\"example.com\",\"value\":\"203.0.113.10\",\"proxied\":false}","acmeEmail":"admin@example.com"}'
```

Use `dim external-url ingress verify NAME` to verify DNS provider state and
HTTPS reachability. Removing an ingress does not delete DNS unless
`--cleanup-dns` is explicitly supplied.

## Policy and trust boundary

The default route policy requires workspace-qualified subdomains. An ingress
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
