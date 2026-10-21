# Shared external URL ingress

`@slop-lab/dim-control-plane-plugin-external-urls` forwards workspace HTTP,
SSE and WebSocket traffic through one control-plane ingress. Each host keeps
the authoritative workspace resolver, approval state and route revocation.
The control plane registers hostname leases and forwards to an operator-fixed
host relay origin. It never accepts workspace IPs or target ports in claims.

Install this plugin with `dim installer install control-plane plugin
'@slop-lab/dim-control-plane-plugin-external-urls@0.10.0'`. It requires the control-plane
runtime, not the host core. Run `dim-control-plane run /absolute/ingress.json`
with a user-owned mode `0600` configuration:

```json
{
  "schemaVersion": 1,
  "plugins": [{
    "package": "@slop-lab/dim-control-plane-plugin-external-urls",
    "config": {
      "schemaVersion": 1,
      "domain": "dev.example.com",
      "publicListen": { "host": "127.0.0.1", "port": 8080 },
      "managementListen": { "host": "10.0.0.1", "port": 8081 },
      "hosts": [
        { "id": "worker-a", "token": "REPLACE_WITH_UNIQUE_RANDOM_32_BYTE_SECRET_A", "relayOrigin": "http://10.0.0.2:8082" },
        { "id": "worker-b", "token": "REPLACE_WITH_UNIQUE_RANDOM_32_BYTE_SECRET_B", "relayOrigin": "http://10.0.0.3:8082" }
      ]
    }
  }]
}
```

Point an existing `*.dev.example.com` wildcard DNS record at the public ingress.
Terminate TLS at an existing reverse proxy, preserving the Host header and
forwarding HTTP upgrades to `publicListen`. An existing wildcard certificate
works without Cloudflare or any DNS provisioning plugin. The DIM service
itself listens for HTTP; use `--scheme https` on hosts when the public edge
terminates HTTPS. Public plain HTTP is also supported with `--scheme http`.

On worker-a, put this connection in a user-owned mode `0600` file outside any
workspace, for example `/home/operator/.config/dim/ingress.json`:

```json
{
  "schemaVersion": 1,
  "endpoint": "http://10.0.0.1:8081",
  "hostId": "worker-a",
  "token": "REPLACE_WITH_UNIQUE_RANDOM_32_BYTE_SECRET_A",
  "domain": "dev.example.com"
}
```

Install the host external-urls plugin and configure its relay:

```sh
dim external-url ingress add control-plane --name shared \
  --description 'Shared development ingress' --scheme https \
  --connection-file /home/operator/.config/dim/ingress.json \
  --listen-host 10.0.0.2 --listen-port 8082
dim external-url ingress verify shared
dim external-url request --workspace my-workspace --ingress shared --port 4096
```

Use worker-b's own host identity, token, connection file and listen address on
that machine. Intermediate host ingresses need no domain or certificate: bind the
relay to a reachable private IP and port, and use that same IP in `relayOrigin`.
The management connection can also use an IP address. Only the final public
ingress needs the wildcard DNS record and, for HTTPS, its certificate.
No per-host public DNS records are required. The requested
service label gains a stable host/workspace identity suffix inside one DNS
label. Identical workspace names on different hosts therefore coexist under
the same wildcard. Permalinks remain unique route identities. Returned URLs
are the addresses to use; do not construct them from workspace names.

Keep the management listener and host relay endpoints on a trusted private
network, firewall, or authenticated network overlay. The public listener must
not expose management. TLS origins are supported for both management and host
relay endpoints; unencrypted private origins require a trusted network. Host
credentials never enter a workspace or browser. A host token can claim names
for that configured host, but cannot change its relay origin or take over an
existing claim belonging to another host or workspace.

Routes renew every 10 seconds and expire after 35 seconds without renewal.
Control-plane restart loses all in-memory leases and fails closed until live
hosts renew. Revoke removes the local owned route before withdrawing the shared
claim, closing existing local and control-plane streams. Expiry and shared
claim removal also close established SSE and WebSocket flows. Host shutdown
withdraws its live routes; an unreachable control plane drops remaining leases
on expiry. Normal approvals, workspace ownership checks and runtime refresh
still run at the host for every new flow.

An unavailable control plane does not prevent the host relay from starting.
New publication fails with a connection error, and already-active host routes
retry their leases. If the host itself restarted during the outage, refresh
that workspace's URL list after the control plane returns to reconcile its
stored routes with current ownership.

The service is an ingress, not a reverse tunnel. The control plane must be
able to reach each configured host relay origin. Use a private routed network
or an overlay when hosts do not have directly reachable addresses.
