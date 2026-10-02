# External workspace URLs

The external URL plugin extends three controller endpoints. Host configuration
uses the host-only admin socket; URL operations are available through the
authenticated workspace and agent sockets:

```text
POST   /v1/external-url/:action    # host administration, including host-wide listing

GET    /api
GET    /api/urls
POST   /api/urls
DELETE /api/urls/:id
```

DIM automatically starts and health-checks the admin, workspace, and agent
sockets in separate host runtime directories. The admin socket is mode `0600`
and is never mounted into a workspace. Every trusted workspace root receives
the workspace socket plus a separately mounted agent socket and distinct
grants. Agent containers should receive only:

```text
DIM_AGENT_CONTROLLER_SOCKET=/run/dim/agent-controller/controller.sock
DIM_AGENT_CONTROLLER_TOKEN=<workspace-scoped agent grant>
```

The DIM CLI automatically uses these agent variables when the stronger
`DIM_CONTROLLER_*` pair is absent. Compose services inherit neither socket nor
grant unless reviewed `.dim` code explicitly passes them through. External URL
routes are agent-audience routes and remain scoped to the authenticated
workspace.

Do not pass the stronger workspace socket and token into a development
container. Passing the agent pair directly is the default. A Project that also
wants to restrict allowed ingresses can use the standard
`dim-controller-proxy`:

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
[External URL example](../../examples/features/external-urls/README.md).

A caller-specific capability may pin its target at the trusted Project
lifecycle boundary:

```bash
dim-controller-proxy external-url \
  --listen /run/dim/web-url/controller.sock \
  --ingress https-ts \
  --bind-containers-json '["agent"]' \
  --bind-protocol http \
  --bind-port 4096 \
  --bind-service-subdomain opencode-web=feature-123--opencode
```

The target binding options are an optional group. Omitting the group preserves
the generic ingress-only capability. Supplying it makes target matching exact
for creation, filtered listing, and revocation authorization. Optional repeated
`--bind-service-subdomain SERVICE=SUBDOMAIN` values additionally restrict the
bound socket to reviewed logical-service mappings. The caller supplies the
logical service name, while the proxy injects the exact subdomain and rejects
unknown services or caller-supplied authority fields. Service mappings require
the complete target-binding group. Projects must use a
distinct socket for a narrower application capability instead of narrowing an
existing generic socket used by other clients.

For self-service tools whose local ports should not appear in reviewed Project
configuration, bind a dedicated proxy socket to the agent container and the
fixed port printed by `dim-development-service gateway-port`. Pass only that
socket as `DIM_DEVELOPMENT_URL_SOCKET`. The agent runs:

```bash
dim-development-service expose \
  --name preview --port 5173 --ingress https-ts --require-scheme https
```

The helper's POST body contains `ingress` and its logical service name. A
service-bound trusted proxy injects both the reviewed workspace-qualified
subdomain and gateway target. A generic target-bound proxy accepts the logical
name for helper compatibility but strips it before forwarding, so the caller
still cannot select an authority. The lazily managed gateway listens on `0.0.0.0:G` inside the
agent container so the trusted ingress can reach it, and routes each returned
exact authority only to an application at `127.0.0.1:PORT`, including WebSocket
upgrades. Where nested container publication is required, trusted Project code
maps the queried gateway port to the same port (`G:G`), because URL creation
stores that bound target port. Re-exposing a stable name with another local
port retains the URL and URL ID. The generic
ingress-only External URL capability remains a separate socket and contract.

Target binding alone fixes the external target, not authority. A service
mapping also fixes the allowed logical names and exact subdomains. Code that
can access the development socket can publish any listed service from its
existing agent loopback authority. This helper therefore avoids granting
container-target or arbitrary-subdomain selection but does not create a
security boundary between mutually untrusted processes in the same agent.

## Named ingresses

An ingress is a host-approved external entry point backed by the plugin's
shared route registry. It combines:

- the public URL scheme and wildcard domain;
- the HTTP reverse-proxy listener;
- the target resolution mode; and
- the name and description shown to workspaces.

Ingresses are host resources shared by every workspace. Arguments after the
common options are owned and interpreted by the selected plugin driver; DIM's
common CLI does not encode driver-specific JSON. HTTP and HTTPS entry points
are configured as separate named ingresses:

```bash
dim external-url ingress add http --name local-http \
  --description "Local development URL" \
  --scheme http \
  --domain dev.test --public-port 8080 \
  --listen-host 0.0.0.0 --listen-port auto \
  --require-approval
```

The CLI sends provider and ingress requests to the plugin's admin API. The
controller atomically stores configuration in
`~/.config/dim/external-urls.json`; override its location with
`DIM_EXTERNAL_URL_CONFIG` in the managed controller environment.

`listenPort:"auto"` is resolved according to the selected driver's contract
and the selected number is persisted. For `http`, `listenHost` and
`listenPort` configure the DIM HTTP router. For `caddy`, they configure the
external HTTPS listener and therefore appear in returned URLs; its loopback
HTTP router is allocated at runtime and is never written to the user
configuration. The CLI restarts the managed controller after ingress changes;
the controller reconciles provider DNS and the Caddy container automatically.

`--require-approval` makes every route requested through that ingress wait for
separate host administration. Omitting it preserves immediate routing for
existing ingresses. Discovery exposes only each ingress's `name`, `description`,
and `scheme`.
Workspaces cannot select domains, listener addresses, upstream hosts, or
arbitrary provider configuration.

### Raw TCP and Tailscale

A `tcp` ingress owns one host listener and one authenticated workspace target
at a time. Its request uses `protocol: "tcp"`, does not accept a path or DNS
subdomain, and returns `tcp://HOST:PORT`. DIM resolves the target through the
same workspace/container boundary as HTTP targets; callers cannot supply an
arbitrary host or loopback upstream. A repeated request for the same workspace
and exact target returns the existing route identity without provisioning or
persisting another claim. A different target or workspace is rejected until
revocation, authoritative workspace discard, or ingress removal releases the
claim.
Persisted claims are resolved and rebound after controller restart. When the
same logical claim resolves to a recreated target runtime generation, including
a replaced nested leaf behind an unchanged relay address, DIM disconnects its
old flows before atomically replacing the upstream. Revocation and listener
shutdown also close both sides of every active flow. Each listener accepts at
most 256 concurrent flows, bounds upstream connection establishment at 10
seconds, and closes a flow after five idle minutes.

The built-in `tailscale` ingress driver is opt-in:

```bash
dim external-url ingress add tailscale --name tailnet-ssh \
  --description "Tailnet SSH" --scheme tcp --listen-port 49152
```

The host must already have an authenticated, running Tailscale daemon and CLI.
The driver invokes only `tailscale status --json`, chooses the current self IPv4
address in `100.64.0.0/10`, and binds exactly that address on the configured
port in `49152..65535`. It never binds `0.0.0.0`, runs `tailscale up`, or uses
Tailscale Serve or Funnel. Tailscale is not a core dependency, and no binary,
state, LocalAPI socket, or authentication material is passed into a workspace
or target container. See the runnable
[Tailnet SSH example](../../examples/features/tailnet-ssh/README.md).

Allowing an ingress through an application socket is a reviewed policy choice.
Selecting a different ingress at runtime is insufficient unless trusted
Project lifecycle code also changes that socket's ingress allowlist. The
Project examples provide an executable Caddy HTTPS configuration at
[`examples/projects/configure-web-ingress.bash`](../../examples/projects/configure-web-ingress.bash);
they do not rely on a cleartext local HTTP ingress for coding-agent Web access.

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

For an HTTP or HTTPS ingress, the request returns two URLs with the same target
and lifecycle: the policy-selected slug in `url` and a stable route permalink in
`permalink`. The permalink authority is
`WORKSPACE-permalink-ROUTE_ID.DOMAIN`. A same-instance policy change may replace
the slug and require fresh approval, but the route ID and permalink remain
stable. Both authorities are reserved atomically, become reachable through the
same approval, follow target rebinding together, and are removed together on
revocation or deletion. Discard and same-name recreation create a fresh route
ID and permalink; the old authorities remain denied. Raw TCP ingresses continue
to return only their `tcp://ADDRESS:PORT` URL and do not create DNS names or
permalinks.

The ingress also returns the route's approval state. The state is
`not-required` for an ordinary ingress and `pending` for an
approval-required ingress. A pending request succeeds but both HTTP/WebSocket
and raw TCP traffic remain denied. On the host, inspect the redacted inventory
and approve the exact route ID:

```bash
dim external-url list
dim external-url approve URL_ID
```

Approval changes the state to `approved` and enables only the persisted
workspace instance, ingress policy revision, logical target, protocol, port,
and authority bound to that ID. Controller restart restores an approved route
only for the same workspace instance and exact tuple. A changed policy or a
same-name workspace recreation cannot reuse the old approval. The policy
revision includes the stable external listener address and port, but excludes
the ephemeral loopback router allocated behind managed Caddy. Policy drift
returns the route to `pending` for a fresh host decision. Revocation, deletion,
and target rebinding close active HTTP streams, WebSocket upgrades, and TCP
flows for the exact route claim before removing or replacing it.

A request may provide any
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
responses, responses above 64 KiB, and non-2xx status codes fail closed. The
policy cannot change the target container or upstream address.

The checked-in
[advanced route-policy example](../../examples/features/external-url-route-policy/README.md)
contains the Unix-socket server used by the automated policy test. The basic
External URL example intentionally uses only the default workspace-prefix
policy.

HTTP and Caddy listeners using the same domain share its hostname routes.
They must therefore configure the same route policy, upstream resolution mode,
and approval requirement; DIM rejects ambiguous configurations at controller
startup.

List and revoke one workspace:

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

On a host, `dim external-url revoke URL_ID` uses the host-admin socket and may
revoke any current route. In a workspace or agent environment, or with
`--workspace`, it remains scoped to that workspace. Revocation reports
`revoked`, immediately removes reachability, and is terminal for that route ID;
a later exposure request receives a fresh pending ID. Workspace and agent
controller routes do not expose approval.

On the host, listing without a workspace selector uses the mode-`0600`
host-admin socket and returns every current workspace's routes with `project`
and `workspace` names:

```bash
dim external-url list
dim external-url list --json
```

The host inventory is capped at 1,000 routes and fails instead of returning a
partial result above that bound. It omits workspace IDs, internal route claims,
controller grants, provider arguments, and credentials. The host-wide action is
not registered on the workspace or agent controller; a workspace or agent grant
continues to see only its own `/api/urls` response.

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
dim install-plugin \
  '@slop-lab/dim-plugin-dns-cloudflare@0.9.0' \
  '@slop-lab/dim-plugin-external-urls@0.9.0'

dim external-url dns-provider add cloudflare \
  --name cloudflare-main \
  --credential "$CF_API_TOKEN"

dim external-url ingress add http --name public-http \
  --description "Public HTTP development URL" \
  --scheme http \
  --domain remote.example.com --public-port 8080 \
  --listen-host 0.0.0.0 --listen-port auto

dim external-url ingress add caddy --name public-https \
  --description "Public HTTPS development URL" \
  --scheme https \
  --domain remote.example.com --listen-host 100.64.0.10 --listen-port 8443 \
  --dns-provider cloudflare-main \
  --dns-argument '{"zone":"example.com","value":"203.0.113.10","proxied":false}'
```

The Cloudflare DNS provider owns only its credential. The driver requires
`argument.credential` and stores it in the mode-`0600` External URL config.
`dns-provider list` does not return provider arguments. The Caddy
driver's `dnsProvider` field references that configured instance.
`dnsArgument` is an opaque string normalized and interpreted by the selected
provider driver. Cloudflare uses `zone`, `value`, and `proxied`, inferring an
`A` record from an IPv4 value, `AAAA` from IPv6, and `CNAME` otherwise.
One provider instance can serve multiple domains and ingresses.
The controller rejects a configured Caddy ingress when its referenced provider
instance or registered driver plugin is missing.

### Static upstream routes

A managed Caddy ingress can reserve exact hostnames under its wildcard domain
and send them directly to host-reachable HTTP services. Static routes take
precedence over workspace routes; all other wildcard hostnames continue to use
the DIM workspace router. For example, add this field to the Caddy ingress
argument to expose managed Gitea as `https://git.remote.example.com:8443`:

```json
{
  "staticRoutes": [
    { "subdomain": "git", "upstream": "http://127.0.0.1:3300" }
  ]
}
```

Each `subdomain` must be one DNS label and unique within the ingress. Each
`upstream` must be an origin-only `http://` or `https://` URL without a path,
query, fragment, or embedded credentials. Because Caddy uses host networking,
`127.0.0.1` addresses the DIM host. Only expose services intended to cross
this trust boundary, and configure the upstream application's canonical
external URL separately when it generates redirects or absolute links. For
managed Gitea, static routing alone does not change its current `ROOT_URL`.

Because the current config contains credentials, do not provide
`~/.config/dim/external-urls.json` to an AI agent or include it in diagnostics.
A separately managed secret store may replace this layout in a later version.

When the controller reloads this ingress, it idempotently creates or updates
`*.remote.example.com`, writes its private generated deployment under the DIM
state root, and starts or updates the Caddy container. The deployment is
controller-owned runtime state rather than a project file. Its generated
`.env` contains the stored credential and remains mode `0600`.
Verify both DNS and HTTPS with:

```bash
dim external-url ingress verify public-https
```

Use a Cloudflare API Token accepted as a Bearer token, not a Global API Key,
restricted to the relevant zone with `Zone.Zone:Read` and `Zone.DNS:Edit`.
Caddy uses DNS-01 for wildcard certificate issuance and renewal.

Caddy uses host networking and binds only `listenHost:listenPort`; it does not
open an HTTP redirect port. In this example, open TCP 8080 for plain HTTP and
TCP/UDP 8443 for HTTPS and HTTP/3.

Removing a Caddy ingress stops and removes its managed container and generated
deployment. The named Docker volumes retain Caddy certificate state when the
same ingress is added again.

Removing an ingress preserves DNS by default. To verify and remove its
provider-managed wildcard record before deleting the local configuration:

```bash
dim external-url ingress remove public-https --cleanup-dns
```

Ingress removal first closes the live listener, disconnects active flows, and
deletes every persisted route and claim for that ingress. Re-adding an ingress
with the same name therefore does not resurrect endpoints removed with the old
configuration.

The authoritative `dim workspace discard` operation invokes plugin cleanup
before removing workspace state, even when the workspace controller grant is
already absent. Calling the lower-level core workspace-discard library without
registered plugin hooks does not provide this plugin cleanup contract.

## Plugin installation

Build the unpublished packages locally:

```bash
pnpm install --frozen-lockfile
bash verification/scripts/pack-local-packages.bash /tmp/dim-packages
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

For plain HTTP external URLs, enable
`@slop-lab/dim-plugin-external-urls`. For Cloudflare/Caddy, also install and
enable `@slop-lab/dim-plugin-dns-cloudflare`; another provider plugin can
register the same driver contract under a different name. Configure at least
one ingress with the CLI and use a workspace command normally. DIM loads
installed plugins when it automatically starts the managed controller.
`dim controller serve --socket PATH` remains available for foreground
debugging.

Loading or listing the plugin before the first ingress exists succeeds and
does not create an empty config file. URL discovery and creation become useful
after `dim external-url ingress add`.

## Verification

[The external URL example](../../examples/features/external-urls/README.md) and
`verification/scripts/external-url-example-smoke.bash` verify:

```text
dnsmasq wildcard DNS
→ named HTTP ingress
→ project-root relay
→ nested dev service
→ further nested container
```

The unit suite verifies ingress discovery, mandatory ingress selection,
multiple target-resolution modes, HTTP proxying, raw TCP forwarding, exclusive
TCP claims, persistence, and revocation.
The example smoke test also runs a local Cloudflare-compatible API backed by
authoritative CoreDNS, then checks provider reconciliation, wildcard
resolution, and cleanup without external credentials.
`just verify headscale-tailnet-tcp` installs the packaged plugin into a pinned
Node/Tailscale host, runs its compiled status driver and `TcpIngressListener`,
and forwards from a second Headscale node to a separate non-tailnet target. It
proves reachability and post-revocation failure while confirming the target has
no Tailscale binary, key, state, socket, or mount. The fixture does not read or
change host Tailscale state. A separately configured operator-owned Tailnet
ingress can additionally run `verification/scripts/tailscale-external-url-smoke.sh`.
