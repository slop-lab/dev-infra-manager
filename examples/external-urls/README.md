# External URLs from nested development containers

This example is a small DIM project with the nesting developers actually use:

```text
project-root workspace container
└── dev (created by the workspace's Docker Compose)
    └── deep (created by dev's own Docker daemon)
```

`dev` serves `hello-from-dev` on port 8080. It also runs a nested Docker daemon
and creates `deep`, which serves `hello-from-deep` on container port 5678 and
publishes it onto `dev`. Neither service publishes a host port.

The copyable project repository is isolated under `repo/`:

```text
examples/external-urls/
├── README.md
└── repo/
    ├── .dim/
    │   ├── docker-compose.yml
    │   └── entrypoint.sh
    └── dev/
        ├── Dockerfile
        └── start.sh
```

The host runs `dim controller serve` and the external URL plugin. Tailscale is
always a host capability: its private host binding must use a host-reachable
reverse proxy. Cloudflare bindings may use a proxy running elsewhere.

## Host configuration

Build and install DIM plus the plugin from this checkout, then configure the
controller:

```bash
export DIM_TAILSCALE_MACHINE=builder-1
export DIM_TAILSCALE_DOMAIN=tail.example.com
export DIM_EXTERNAL_URL_PROXY_HOST=100.64.0.10
export DIM_EXTERNAL_URL_PROXY_PORT=443
export DIM_EXTERNAL_URL_PROXY_UPSTREAM_MODE=container-ip
export DIM_EXTERNAL_URL_PROFILES='{
  "tailscale": {
    "description": "Private development URL on the host tailnet",
    "protocol": "https"
  }
}'
export DIM_EXTERNAL_URL_BINDINGS='{
  "tailscale": {
    "routeProvider": "reverse-proxy",
    "urlProvider": "tailscale"
  }
}'

dim controller serve
```

Wildcard DNS for `*.builder-1.tail.example.com` points at the host's Tailscale
IP. TLS termination can run in front of the plugin proxy. Tailscale is never
installed in a workspace or controller container.

## Project use

Copy or initialize `repo/` as a Git repository, register it as the DIM project
root, and create a development workspace. Its normal setup starts `dev` and
`deep`:

```bash
dim create external external-dev --profile development
dim run external-dev discover | jq '.routes[] | select(.path == "/api/urls")'
dim run external-dev expose-dev tailscale
dim run external-dev expose-deep tailscale
```

The requests name a host-configured profile. They cannot select raw providers,
hostnames, IPs, or arbitrary upstreams. `containers: ["dev"]` resolves the
Compose service inside the project-root container. `["dev", "deep"]` resolves
the nested container's published port through `dev`. DIM creates a TCP relay
inside the project-root container so the host reverse proxy can reach both.

## Verification

`scripts/external-url-example-smoke.bash` runs the complete example with a host
controller and reverse proxy. The host-side harness is intentionally outside
the copyable repository because it builds unpublished local packages,
constructs controller state, allocates ports and Docker networks, and performs
cleanup. It copies only `repo/` into a newly created project-root workspace
container, starts fresh `dev` and `deep` containers there, uses dnsmasq for
wildcard test DNS, and checks both generated URLs from separate disposable curl
containers:

```bash
just verify-example-external-urls
```

No Tailscale account is needed for that deterministic verification; the
dnsmasq test profile models the same host wildcard-DNS data path.
