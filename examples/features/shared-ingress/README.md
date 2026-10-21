# Shared ingress across workspace hosts

One existing `*.dev.example.com` wildcard DNS record points to the control-plane
edge. Workspace hosts register scoped service names through their External URLs
plugin; their relay listeners need only reachable private IPs and ports, without
a domain, TLS certificate or Cloudflare account. Only the final edge needs DNS
and its HTTPS certificate. Two hosts
can use the same workspace name: the first route uses the readable service
label, and a name collision uses a host/workspace identity suffix. Use the returned URL rather than constructing it.

[`recipe.json`](recipe.json) declares both independently installed plugins. No
project repository is required: this is shared infrastructure for ordinary or
managed workspaces. Configure the private network and edge TLS using the complete
[control-plane service example](../../../packages/control-plane/plugins/external-urls/README.md).
The control plane must reach the configured host relay endpoints. An existing
reverse proxy can terminate HTTPS; the DIM public listener itself serves HTTP.

Run installation stages on their respective machines:

```sh
node scripts/examples/run.ts examples/features/shared-ingress install-control-plane
node scripts/examples/run.ts examples/features/shared-ingress install-host
```

`dev` runs the installed control-plane runtime with an explicit private service
file; it does not overwrite configuration or create credentials:

```sh
export DIM_SHARED_INGRESS_CONFIG=/absolute/private/ingress.json
export DIM_CONTROL_PLANE_BIN=/absolute/installed/node_modules/.bin/dim-control-plane
node scripts/examples/run.ts examples/features/shared-ingress dev
```

On each workspace host, configure the `control-plane` ingress driver with its
private connection file as shown in the service example. In DIM Web, open that
workspace's **External routes**, choose the shared ingress and create a route.
An OpenCode server uses port 4096. Required approvals remain explicit.

The executable `verify` stage starts a real control-plane ingress and two host
relays on disposable local ports. It verifies same-name workspaces, separate
upstreams, permalink routing, host authentication, collision rejection, active
HTTP/SSE/WebSocket revocation, lease expiry and restart recovery. No DNS, account,
Docker, or installed service is changed:

```sh
node scripts/examples/run.ts examples/features/shared-ingress verify
```

There is no automatic VM stage: a reachable host relay network and operator-owned
edge TLS are explicit deployment prerequisites.
