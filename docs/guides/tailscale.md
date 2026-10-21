# Workspace tailnet access

Install `@slop-lab/dim-host-plugin-tailscale` on the DIM host to let ordinary
workspace processes and their nested agent containers reach IPv4 tailnet peers.
No Project configuration or control plane is required.

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-tailscale@0.10.0'
dim tailscale configure --hostname dim-workspaces
dim tailscale up
dim tailscale status
```

`up` pulls the configured digest-pinned gateway image and starts authentication.
Follow its login URL when authentication is needed. To use a pre-created auth
key, put it in a private, operator-owned regular file and supply its absolute
path:

```sh
chmod 600 /absolute/path/to/tailscale-auth-key
dim tailscale up --auth-key-file /absolute/path/to/tailscale-auth-key
```

The key travels over stdin to a temporary private file inside the gateway and
is removed after the login command. It is absent from Docker arguments and
workspace configuration. The resulting node identity persists in the gateway's
owned Docker state volume. Do not use a project checkout to store auth keys.

For Headscale or another selected control server, configure it before login:

```sh
dim tailscale configure --hostname dim-workspaces \
  --login-server https://headscale.example.com
dim tailscale up
```

`configure --image REGISTRY/IMAGE@sha256:DIGEST` selects an explicitly pinned
image. Replacing the gateway image replaces its runtime container while keeping
the owned state volume and authenticated node identity. Configuration and pulling
are operator operations; opening a workspace does not download new gateway code
or silently authenticate a node.

## Workspace and agent networking

The plugin manages one dedicated kernel-networking gateway container on the
host. Only that container receives `/dev/net/tun`, networking capabilities and
the VPN state volume. Guests receive neither VPN credentials nor the Tailscale
control socket, and do not need to run Tailscale themselves.

The gateway joins each supported workspace's existing private bridge. The
workspace retains its single network attachment. Its `100.64.0.0/10` route uses
the gateway; source NAT makes connections use the gateway's tailnet identity.
Tailnet policy therefore applies to that shared gateway identity rather than
individual workspace identities. Gateway forwarding blocks traffic between
workspace bridges and unsolicited inbound tailnet connections.

The plugin sets the workspace resolver to Tailscale's `100.100.100.100` and adds
the tailnet DNS search suffix when available. Newly created nested agent
containers inherit the workspace resolver through Docker's default DNS behavior.
Explicit operator DNS overrides are left intact. The plugin does not restart
Docker or rewrite its daemon configuration. Existing containers may need
recreation to adopt changed DNS settings.

Routes and gateway attachment are reconciled after workspace start, before
`exec` or `connect`, and after a running workspace is recreated. Final discard
first detaches its bridge from the gateway. Discover the integration inside a
workspace with `dim-workspace plugins`; run administrative setup on the host.

Supported runtimes are `container` and `container-kvm`. The Incus `vm` workspace
runtime is unsupported. This provides IPv4 tailnet peer access, not IPv6,
advertised subnet routes or an exit-node default route. Host internet routing,
host DNS and an existing host Tailscale node are unchanged.

## Optional inbound access

The same package contributes the `tailscale` driver to the optional
[External URLs plugin](external-urls.md). That driver binds a scoped TCP listener
to the **host's existing authenticated Tailscale node**. It is independent of the
outbound gateway: configuring either feature does not enable the other.
Install External URLs alongside this plugin and restart its controller before
selecting that ingress driver. See the [package example](../../packages/host/plugins/tailscale/README.md#tailscale-tcp-ingress).

## Reinstalling development sources

Local uninstall and reinstall retain Tailscale gateway configuration and its
node-authentication state volume. Runtime containers and networks are removed;
`dim tailscale up` recreates the gateway using the retained identity after the
matching plugin is installed. `--no-keep-cache-data` affects package cache
payloads, not VPN authentication or LLM router data. See the complete
[local removal and reinstall scope](usage.md#remove-or-reinstall-a-local-source-installation).

## Disposable verification

With a reviewed workspace image already available locally, run:

```sh
DIM_TAILNET_WORKSPACE_IMAGE=REVIEWED_LOCAL_WORKSPACE_IMAGE just verify tailscale-gateway
```

The check requires local Docker with `sysbox-runc` and `/dev/net/tun`. It creates
an independent disposable Headscale tailnet and tests workspace and nested-agent
routing and DNS through the actual gateway. It does not reuse the host's
Tailscale socket, credentials or node state. See the [verification guide](../development/verification.md)
for the other local runtime checks.
