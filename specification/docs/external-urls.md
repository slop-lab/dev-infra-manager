# External workspace URLs

For ordinary remote development, `dim forward WORKSPACE LOCAL:REMOTE` exposes a
workspace loopback service through the selected SSH host. It requires no URL
plugin, Project or control plane. Use the optional External URLs plugin when a
host should own persistent named HTTP, HTTPS or TCP entry points.

Run the following commands on the trusted host that owns the workspace. The
optional controller uses host-only Unix sockets; these examples do not mount
controller grants or host sockets into development containers.

## First HTTP route

```sh
dim installer install core --with-managed
dim installer install plugin '@slop-lab/dim-plugin-external-urls@0.10.0'
dim external-url ingress add http --name local-http \
  --description 'Development HTTP' --scheme http \
  --domain dev.test --public-port 8080 \
  --listen-host 127.0.0.1 --listen-port 8080

dim external-url discover --workspace dev
dim external-url request --workspace dev --ingress local-http \
  --subdomain dev--app --port 3000 --protocol http
dim external-url list --workspace dev
curl --resolve dev--app.dev.test:8080:127.0.0.1 http://dev--app.dev.test:8080/
```

The service in this example listens on `127.0.0.1:3000` inside workspace `dev`.
Add `--container app` to select one container named `app` in its nested Docker
engine. Targets support zero or one container name, not a two-level container
path. Ordinary Git workspaces need no native Project metadata.

The controller validates the core workspace UUID and Docker ownership before
resolving a target. It starts or reuses an in-agent byte relay and routes to that
owned agent's IP. The host gateway never accepts an arbitrary upstream host
from the workspace request. HTTP requests, WebSocket upgrades and new TCP
connections revalidate the current UUID before using a cached target. Discard
or same-name replacement makes old routes unreachable without a controller
restart or a discard callback.

## Host configuration and route approval

Ingresses are shared host resources. The plugin stores private configuration
at `~/.config/dim/external-urls.json`; `DIM_EXTERNAL_URL_CONFIG` selects another
file in the controller environment. Run `dim controller restart` after changing
a running controller's configuration. Driver-specific arguments follow the
common ingress options and belong to the selected driver.

Add `--require-approval` when routes should start as `pending`:

```sh
dim external-url approve URL_ID
dim external-url revoke URL_ID
dim external-url revoke URL_ID --workspace dev
```

Only host administration can approve. A scoped workspace command can revoke
its own route. Revocation is terminal for that stored URL ID; a later request
creates a new pending ID. Revoking, deleting or rebinding a route closes its
tracked HTTP streams, WebSocket upgrades and TCP flows. Changes to public
exposure or approval policy require fresh approval before traffic resumes.

HTTP route names default to the next available workspace-qualified subdomain.
A route also receives a permalink tied to its UUID. A host-configured route
policy can require workspace prefixes or delegate naming to an explicit
HTTP(S)/Unix-socket policy service. Reconciliation preserves route identities
and checks approval policy when a controller restarts.

Without `--workspace`, `dim external-url list --json` uses the host-admin socket
and returns at most 1,000 routes for current core workspaces. Project names are
included only when native attachments provide them. With `--workspace`, listing
uses a scoped token and returns only that workspace's routes. Neither listing
returns grants, DNS credentials or private provider arguments.

## HTTPS and DNS drivers

The External URLs package owns the shared HTTP router and its Caddy frontend;
DNS providers are separate explicit extensions. For Cloudflare:

```sh
dim installer install plugin '@slop-lab/dim-plugin-dns-cloudflare@0.10.0'
dim external-url dns-provider add cloudflare --name cloudflare-main \
  --credential "$CF_API_TOKEN"
dim external-url ingress add caddy --name public-https \
  --description 'Development HTTPS' --scheme https \
  --domain dev.example.com --listen-host 127.0.0.1 --listen-port 8443 \
  --dns-provider cloudflare-main --acme-email operator@example.com
```

Review the ingress with `dim external-url ingress list --json` and
`dim external-url ingress verify public-https`. Caddy owns TLS termination and
forwards to the managed loopback router. DNS credentials remain in private host
configuration and are absent from workspace controller responses. Existing host
network and DNS configuration determines which clients can reach the listener.

Raw TCP drivers expose one scoped target per listener. They preserve raw
protocol bytes and reject HTTP-only path or subdomain inputs. The packaged
Tailscale driver resolves the running host's own address; it does not configure
a tailnet or grant host administration to a workspace.

## Verification

Centralized plugin tests exercise live HTTP, TCP and WebSocket flows, approval
and revocation, persistence failures, ingress removal, target rebinding and
same-name/cached-IP reuse. They use actual core workspace records.

After building matched packages and a base Sysbox workspace image:

```sh
node verification/scripts/controller-workspace-relay-smoke.mjs IMAGE
```

The disposable-container smoke verifies the owned loopback relay, concurrent
binary transfers with half-close responses, process reuse, UUID fencing and
discard cleanup. It does not require the retired two-container Project runtime.
