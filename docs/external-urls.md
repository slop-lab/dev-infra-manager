# External workspace URLs

DIM exposes one authenticated controller API that the external URL system
plugin extends:

```text
GET    /api
GET    /api/urls
POST   /api/urls
DELETE /api/urls/:id
```

Every new workspace receives a workspace-scoped controller grant:

```text
DIM_CONTROLLER_API=http://host.docker.internal:7070
DIM_CONTROLLER_TOKEN=<workspace-scoped grant>
```

The controller port must be reachable from workspaces but must not be exposed
publicly.

## Named ingresses

An ingress is a host-approved external entry point. It combines:

- the public URL scheme and wildcard domain;
- the HTTP reverse-proxy listener;
- the target resolution mode; and
- the name and description shown to workspaces.

There is no separate external URL profile or provider binding. HTTP and HTTPS
entry points are configured as separate named ingresses:

```text
DIM_EXTERNAL_URL_INGRESSES={
  "local-http": {
    "description": "Local development URL",
    "scheme": "http",
    "domain": "dev.test",
    "port": 8080,
    "listenHost": "0.0.0.0",
    "listenPort": 8080,
    "upstreamMode": "container-ip"
  },
  "public-https": {
    "description": "Public HTTPS development URL",
    "scheme": "https",
    "domain": "dev.example.com",
    "listenHost": "127.0.0.1",
    "listenPort": 9080,
    "upstreamMode": "container-ip"
  }
}
```

`port` is the optional port placed in generated public URLs. `listenHost` and
`listenPort` select the plugin's internal HTTP router. For an HTTPS ingress,
Caddy or another TLS terminator listens publicly on port 443 and forwards the
original Host header to that internal router.

Discovery exposes only each ingress's `name`, `description`, and `scheme`.
Workspaces cannot select domains, listener addresses, upstream hosts, or
arbitrary provider configuration.

## Discovery and requests

Discover ingresses:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  "$DIM_CONTROLLER_API/api"
```

Create a URL:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "ingress": "public-https",
    "service": "web",
    "target": {
      "containers": ["dev"],
      "port": 3000,
      "protocol": "http"
    }
  }' \
  "$DIM_CONTROLLER_API/api/urls"
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

List and revoke:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  "$DIM_CONTROLLER_API/api/urls"

curl --fail --silent -X DELETE \
  -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
  "$DIM_CONTROLLER_API/api/urls/URL_ID"
```

## HTTPS with Cloudflare DNS and Caddy

The system plugin is provider-agnostic. A public deployment can put Caddy in
front of a loopback-bound ingress:

```text
*.dev.example.com
→ Caddy :443
→ DIM ingress router 127.0.0.1:9080
→ workspace relay
→ nested service
```

Configure a wildcard DNS record in Cloudflare that points
`*.dev.example.com` to the host. Build Caddy with the Cloudflare DNS module,
then configure wildcard TLS and preserve the incoming Host header:

```caddyfile
*.dev.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}

	reverse_proxy 127.0.0.1:9080
}
```

Use a Cloudflare API token restricted to the relevant zone. Caddy uses it for
the ACME DNS-01 challenge and automatic certificate renewal. Keep the token in
the Caddy runtime; the DIM controller and workspace containers do not need it.

A future Cloudflare DNS provider plugin can automate wildcard record
provisioning and verification without changing the ingress request contract.

## Plugin installation

Build the unpublished packages locally:

```bash
pnpm install --frozen-lockfile
pnpm run workspace:build
npm pack ./packages/core/dist --pack-destination /tmp
npm pack ./packages/external-urls/dist --pack-destination /tmp
```

Install both tarballs in the configured plugin home, list
`@slop-lab/dim-plugin-external-urls` in `plugins.json`, set
`DIM_EXTERNAL_URL_INGRESSES`, then run:

```bash
dim controller serve --host 0.0.0.0 --port 7070
```

## Verification

[The external URL example](../examples/external-urls/README.md) and
`scripts/external-url-example-smoke.bash` verify:

```text
dnsmasq wildcard DNS
→ named HTTP ingress
→ project-root relay
→ nested dev service
→ further nested container
```

The unit suite verifies ingress discovery, mandatory ingress selection,
multiple target-resolution modes, HTTP proxying, persistence, and revocation.
A separately configured Tailnet ingress can run
`scripts/tailscale-external-url-smoke.sh`.
