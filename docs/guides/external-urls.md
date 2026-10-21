# External workspace URLs

For ordinary remote development, `dim forward WORKSPACE LOCAL:REMOTE` exposes a
workspace loopback service through the selected SSH host. It requires no URL
plugin, Project or control plane. Use the optional External URLs plugin when a
host should own persistent named HTTP, HTTPS or TCP entry points.

DIM Web exposes **External routes** inside each workspace management row when its
Web plugin is installed. Choose an ingress, service name and port, then create the
route. OpenCode uses workspace port 4096. The same row's **Workspace tools** starts
and stops its server. Creating a route does not implicitly approve it: pending
routes require **Approve route**, and **Revoke route** removes their reachability.

Run the following commands on the trusted host that owns the workspace. The
optional controller uses host-only Unix sockets; these examples do not mount
controller grants or host sockets into development containers.

## First HTTP route

```sh
dim installer install core --with-managed
dim installer install plugin '@slop-lab/dim-host-plugin-external-urls@0.10.0'
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
connections revalidate the current UUID and resolve its owned runtime before
connecting. Container recreation restores its relay on the next flow without
listing routes or restarting the controller. A missing runtime cannot send
traffic to a foreign container that reused its IP. Existing flows stay pinned
to their selected endpoint. Discard or same-name replacement makes old routes
unreachable without a controller restart or a discard callback.

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

An existing wildcard DNS record is sufficient. The HTTP ingress never provisions
DNS; an existing reverse proxy can terminate HTTPS and forward to it while
preserving Host and HTTP upgrades. Cloudflare is an optional DNS automation
integration, rather than a requirement to expose a workspace.

For host-managed Caddy with an existing wildcard certificate and DNS, specify
the certificate and key instead of a DNS provider:

```sh
dim external-url ingress add caddy --name existing-https \
  --description 'Existing wildcard DNS and TLS' --scheme https \
  --domain dev.example.com --listen-host 0.0.0.0 --listen-port 443 \
  --tls-cert /absolute/private/fullchain.pem \
  --tls-key /absolute/private/privkey.pem
```

Caddy validates wildcard coverage, expiry and the matching private key. The key
is mounted read-only only into the trusted Caddy service. This mode neither
creates nor removes DNS records and does not issue or renew certificates; after
renewing the files, restart the host controller to load them.

The External URLs package owns the shared HTTP router and its Caddy frontend;
DNS providers are separate explicit extensions. For Cloudflare:

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-dns-cloudflare@0.10.0'
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

## One ingress for multiple hosts

Install `@slop-lab/dim-control-plane-plugin-external-urls` on the control plane
and select the host plugin's `control-plane` ingress driver on each workspace
host. One existing wildcard DNS record points to the shared ingress, which
forwards each hostname to the operator-configured host relay. Hosts do not need
individual public DNS records. Identity suffixes inside the service label keep
same-name workspaces on different hosts distinct.

The shared service needs only the control-plane runtime, with no host core.
Private per-host connection files authorize hostname claims; workspace targets
and approvals remain at the host. The public HTTP listener can sit behind an
existing TLS reverse proxy with an already managed certificate. Keep management
and host relays on a trusted private network or authenticated network overlay.
This is a routed ingress, so the control plane must reach each host relay.

See the [complete service and host configuration](../../packages/control-plane/plugins/external-urls/README.md)
and the [runnable two-host example](../../examples/features/shared-ingress/README.md).
Claims expire without renewal, and revocation closes existing HTTP streams and
WebSockets at both layers. A shared-ingress outage does not prevent the local
host controller from starting.

## Other ingress drivers

Raw TCP drivers expose one scoped target per listener. They preserve raw
protocol bytes and reject HTTP-only path or subdomain inputs. The optional
`@slop-lab/dim-host-plugin-tailscale` supplies the Tailscale ingress driver. Install
it alongside External URLs before selecting a `tailscale` ingress:

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-tailscale@0.10.0'
```

This ingress driver resolves the running host's own address. It requires an
already connected host Tailscale node and does not alter its authentication or
network settings. Workspace outbound connectivity is configured separately by
the Tailscale plugin; ingress selection does not enable it.

## Verification

Centralized plugin tests exercise live HTTP, TCP and WebSocket flows, approval
and revocation, persistence failures, ingress removal, target rebinding and
same-name/cached-IP reuse. They use actual core workspace records.

After building matched packages and a base Sysbox workspace image:

```sh
node scripts/checks/controller-workspace-relay-smoke.ts IMAGE
```

The disposable-container smoke verifies the owned loopback relay, concurrent
binary transfers with half-close responses, process reuse, UUID fencing and
discard cleanup. It does not require the retired two-container Project runtime.
