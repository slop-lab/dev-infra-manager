# Example: External URLs

This Project exposes services from two nested levels without publishing a
Docker port on the host:

```text
workspace container
└── dev (Project Docker daemon, HTTP :8080)
    └── deep (dev's private Docker daemon, HTTP :5678)
```

The short scripts beside this README contain the repetitive Git and DIM
commands. Read them before running them; they are intentionally small. Both
server images are pinned by digest.

## Try it

Wildcard DNS for `*.host.tail.test` must resolve to this host. Then run:

```bash
dim install-plugin \
  '@slop-lab/dim-plugin-dns-cloudflare@0.9.0' \
  '@slop-lab/dim-plugin-external-urls@0.9.0'
dim plugin list
dim doctor
bash create-repository.bash
bash register-project.bash
bash configure-ingress.bash
dim workspace create external external-dev --profile development
bash request-urls.bash external-dev
```

DIM starts its managed host controller automatically. The last command uses the
host CLI's `--workspace external-dev` option, which loads only that workspace's
grant, and prints pending URLs for `dev` and `deep`. The request supplies no URL
names; the controller assigns the first available workspace-qualified names
(`0`, then `1`). Neither nested service receives a DIM controller socket,
workspace grant, host Docker socket, or host runtime secret.

Before the first ingress is configured, the plugin starts normally and
`dim plugin list` succeeds. Inspecting it does not create an empty
configuration file; `configure-ingress.bash` creates the first real config.

The ingress fixes the public domain and listener in host configuration and
requires separate host approval. Workspace-scoped requests select only the
ingress and a container path:

```text
dev:  containers=[dev],      port=8080
deep: containers=[dev,deep], port=5678
```

Requests cannot choose another workspace, domain, listener, hostname, IP, or
upstream.
Repeating `--container` walks from the workspace container through each
nested runtime.

Inspect the pending inventory on the host and record each route's `id`, `url`,
and `approval` fields:

```bash
dim external-url list --json
```

Before approval, both returned URLs respond with `404`. Approve the exact route
IDs as host administrator, then the same URLs serve `hello-from-dev` and
`hello-from-deep`:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' DEV_URL
dim external-url approve DEV_URL_ID
dim external-url approve DEEP_URL_ID
curl --fail --silent --show-error DEV_URL
curl --fail --silent --show-error DEEP_URL
```

Approval is deliberately absent from the authenticated workspace API. A
workspace grant can request, list, and revoke only its own routes; it cannot
approve one or use the host-admin API.

Discarding the workspace revokes both routes. Repeating either request after
discard returns `404`:

```bash
dim workspace discard external-dev --yes
curl --silent --output /dev/null --write-out '%{http_code}\n' DEV_URL
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
details are in [External workspace URLs](../../../specification/docs/external-urls.md).

## Verification

The smoke test builds and installs the local packages, loads the plugin before
any config exists, and then runs this example's actual
`configure-ingress.bash` and `request-urls.bash` scripts. It starts the same
workspace/dev/deep layout, proves pending routes return `404`, proves a
workspace-scoped caller cannot approve them, approves them through host
administration, and reaches both expected bodies from a separate client
network through wildcard DNS. It then discards the workspace and proves both
routes return `404`. The smoke also checks loopback-only ingress isolation,
generated Caddy configuration, and Cloudflare-style DNS creation and cleanup
without using a real DNS account:

```bash
just verify example current-installed auto external-urls
just verify example runc use external-urls
```
