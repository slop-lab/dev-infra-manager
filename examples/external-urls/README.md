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
dim install-plugin '@slop-lab/dim-plugin-external-urls@0.2.0'
dim plugin list
dim doctor
bash create-repository.bash
bash register-project.bash
bash configure-ingress.bash
dim create external external-dev --profile development
dim exec external-dev -- bash .dim/create-urls.bash
```

DIM starts its managed host controller automatically. The last command asks
the trusted root to execute [the request script](repo/dev/request-urls.bash)
inside `dev`. Reviewed [setup code](repo/.dim/setup.sh) runs
`dim-controller-proxy` with the `local-http` ingress allowlisted. `dev` gets
only that restricted socket—not the host controller socket or workspace
grant—and prints URLs for `dev` and `deep`. It
supplies neither a workspace name nor URL names: the controller already knows
the current workspace and assigns the first available names (`0`, then `1`).

Before the first ingress is configured, `dim plugin list` succeeds and warns
that the plugin has no ingress yet. Inspecting it does not create an empty
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
dim discard external-dev --yes
```

## HTTPS

For a public wildcard domain, the Caddy example combines plain HTTP on port
8080 with loopback-routed HTTPS on port 443 using Cloudflare DNS-01. The
generated deployment shape is shown in
[host/cloudflare-caddy](host/cloudflare-caddy/README.md). Full configuration
and security details are in
[External workspace URLs](../../docs/external-urls.md).

## Verification

The smoke test builds and installs the local packages, loads the plugin before
any config exists, and then runs this example's actual
`configure-ingress.bash` and `.dim/create-urls.bash` scripts. It starts the same
workspace/dev/deep layout and reaches both URLs from a separate client network
through wildcard DNS. It also checks URL revocation, loopback-only ingress
isolation, generated Caddy configuration, and Cloudflare-style DNS creation
and cleanup without using a real DNS account:

```bash
just verify-example-external-urls
```
