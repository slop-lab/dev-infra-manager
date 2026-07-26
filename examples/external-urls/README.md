# External URLs from nested development containers

This example is a small DIM project with the nesting developers actually use:

```text
project-root workspace container
└── dev (created by the workspace's Docker Compose)
    └── deep (created by dev's own Docker daemon)
```

`dev` serves `hello-from-dev` on port 8080. It also creates `deep`, which
serves `hello-from-deep` on container port 5678 and publishes it onto `dev`.
Neither service publishes a host port.

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

## Host ingress

The host runs `dim controller serve` with one named HTTP ingress:

```bash
export DIM_EXTERNAL_URL_INGRESSES='{
  "local-http": {
    "description": "Local HTTP development URL",
    "scheme": "http",
    "domain": "host.tail.test",
    "port": 8080,
    "listenHost": "0.0.0.0",
    "listenPort": 8080,
    "upstreamMode": "container-ip"
  }
}'

dim controller serve
```

Wildcard DNS for `*.host.tail.test` points at the host. For a public HTTPS
deployment, configure a separate `public-https` ingress whose internal router
binds to loopback, then place Caddy with Cloudflare DNS-01 in front of it. See
[External workspace URLs](../../docs/external-urls.md).

## Project use

Copy or initialize `repo/` as a Git repository, register it as the DIM project
root, and create a development workspace. Its normal setup starts `dev` and
`deep`:

```bash
dim create external external-dev --profile development
dim run external-dev discover | jq '.routes[] | select(.path == "/api/urls")'
dim run external-dev expose-dev local-http
dim run external-dev expose-deep local-http
```

The requests select only a host-configured ingress. They cannot select a raw
domain, listener, hostname, IP, or upstream. `containers: ["dev"]` resolves the
Compose service inside the project-root container. `["dev", "deep"]` resolves
the nested container's published port through `dev`.

## Verification

`scripts/external-url-example-smoke.bash` runs the complete example with a host
controller and named ingress. The host-side harness builds unpublished local
packages, constructs controller state, allocates ports and Docker networks,
and performs cleanup. It uses dnsmasq for wildcard test DNS and checks both
generated URLs from separate disposable curl containers:

```bash
just verify-example-external-urls
```

No external DNS account is needed for this deterministic verification.
