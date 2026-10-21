# Tailscale host plugin

The host plugin provides a private outbound gateway for workspaces and nested
agents, plus an independent ingress driver for External URLs.

```sh
dim installer install plugin @slop-lab/dim-host-plugin-tailscale@0.10.0
dim tailscale configure --hostname dim-workspaces
dim tailscale up
dim tailscale status
```

Use `dim tailscale up --auth-key-file /absolute/private/key` for auth-key login.
The host owns VPN authentication and state; guests receive IPv4 tailnet routing
and DNS, without a VPN socket or credentials. `container` and `container-kvm`
are supported; the Incus `vm` runtime is not. Read the [networking and setup
guide](../../../../docs/guides/tailscale.md) for scope, DNS behavior and retained
state during reinstall.

The ingress contribution is enabled only when the matching external-urls
integration is installed.

## Tailscale TCP ingress

The `tailscale` driver exposes one raw TCP target through the DIM
host's existing Tailscale node. Tailscale must already be installed,
authenticated, and running on the host. Configuration is explicit and accepts
only a high listener port. Install matching packages on the host:

```bash
dim installer install plugin @slop-lab/dim-host-plugin-tailscale@VERSION @slop-lab/dim-host-plugin-external-urls@VERSION
dim controller restart
```

Then configure the selected ingress:

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
shutdown and explicit route rebinding destroy both socket directions. Each new
connection resolves the current owned runtime. Existing connections remain
pinned to their selected target until they end or are explicitly revoked.
Closing one sending direction preserves the other direction, including a
server response sent after the client finishes uploading.

