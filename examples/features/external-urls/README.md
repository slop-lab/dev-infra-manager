# Example: External URLs

This Project exposes services from two nested levels without publishing a
Docker port on the host:

```text
workspace container
└── dev (Project Docker daemon, HTTP :8080)
    └── deep (dev's private Docker daemon, HTTP :5678)
```

The short scripts beside this README contain the repetitive Git and DIM
commands. Read them before running them; they are intentionally small.

## Try it

Wildcard DNS for `*.host.tail.test` must resolve to this host. Then run:

```bash
dim install-plugin \
  '@slop-lab/dim-plugin-dns-cloudflare@0.8.0' \
  '@slop-lab/dim-plugin-external-urls@0.8.0'
dim plugin list
dim doctor
bash create-repository.bash
bash register-project.bash
bash configure-ingress.bash
dim workspace create external external-dev --profile development
dim workspace exec external-dev -- bash .dim/create-urls.bash
```

DIM starts its managed host controller automatically. The last command asks
the trusted root to execute
[the request script](repos/root/dev/request-urls.bash) inside `dev`. Reviewed
[setup code](repos/root/.dim/setup.sh) runs
`dim-controller-proxy` with the `local-http` ingress allowlisted. `dev` gets
only that restricted socket—not the host controller socket or workspace
grant—and prints URLs for `dev` and `deep`. It
supplies neither a workspace name nor URL names: the controller already knows
the current workspace and assigns the first available names (`0`, then `1`).

Before the first ingress is configured, the plugin starts normally and
`dim plugin list` succeeds. Inspecting it does not create an empty
configuration file; `configure-ingress.bash` creates the first real config.

The ingress fixes the public domain and listener in host configuration.
Project requests select only the ingress and a container path:

```text
dev:  containers=[dev],      port=8080
deep: containers=[dev,deep], port=5678
```

The proxy permits filtered External URL discovery, list, request, and
individual revoke operations only for `local-http`. It rejects other
controller APIs and ingress names.
Requests also cannot choose a workspace, domain, listener, hostname, IP, or
upstream.
Repeating `--container` walks from the workspace container through each
nested runtime.

Discard the workspace when finished:

```bash
dim workspace discard external-dev --yes
```

## HTTPS

For a public wildcard domain, plain HTTP can use DIM's built-in router on port
8080 while Caddy binds a selected external HTTPS address and forwards through
a driver-managed loopback router:

```bash
dim external-url dns-provider add cloudflare \
  --name cloudflare-main \
  --credential "$CF_API_TOKEN"

dim external-url ingress add http --name public-http \
  --description "Public HTTP development URL" \
  --scheme http \
  --domain remote.example.com --public-port 8080 \
  --listen-host 0.0.0.0 --listen-port 8080

dim external-url ingress add caddy --name public-https \
  --description "Public HTTPS development URL" \
  --scheme https \
  --domain remote.example.com --listen-host 100.64.0.10 --listen-port 8443 \
  --dns-provider cloudflare-main \
  --dns-argument '{"zone":"example.com","value":"203.0.113.10","proxied":false}'
```

The ingress change restarts the managed controller. It reconciles
`*.remote.example.com`, generates controller-owned Caddy runtime state, and
starts the Caddy container automatically. Verify the resulting ingress:

```bash
dim external-url ingress verify public-https
```

Use a zone-scoped Cloudflare API Token with `Zone.Zone:Read` and
`Zone.DNS:Edit`, not a Global API Key. The host must accept TCP 8080 and
TCP/UDP 8443. Full configuration and security
details are in [External workspace URLs](../../../docs/external-urls.md).

## Verification

The smoke test builds and installs the local packages, loads the plugin before
any config exists, and then runs this example's actual
`configure-ingress.bash` and `.dim/create-urls.bash` scripts. It starts the same
workspace/dev/deep layout and reaches both URLs from a separate client network
through wildcard DNS. It also checks URL revocation, loopback-only ingress
isolation, generated Caddy configuration, and Cloudflare-style DNS creation
and cleanup without using a real DNS account:

```bash
just verify example current-installed auto external-urls
just verify example runc use external-urls
```
