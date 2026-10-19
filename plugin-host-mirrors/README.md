# `@slop-lab/dim-plugin-host-mirrors`

Connect ordinary Git workspaces and optional managed CI to shared Docker Hub,
npm, PyPI and APT caches. This optional **client** plugin configures consumers;
it does not install, start, replace or own cache servers. It requires DIM core;
managed CI is an optional peer.

```sh
dim installer install plugin '@slop-lab/dim-plugin-host-mirrors@0.10.0'
```

## Select cache URLs

A cache host may independently install the optional
[`cache-server`](../plugin-cache-server/README.md) plugin:

```sh
dim installer install plugin '@slop-lab/dim-plugin-cache-server@0.10.0'
dim cache-server ensure
dim mirrors ensure
```

The server publishes a private host catalog at
`$DIM_STATE_ROOT/services/package-caches.json`. Without `DIM_STATE_ROOT`, the
state root is `$XDG_STATE_HOME/dim`, or `~/.local/state/dim`. The client reads
this catalog without importing the server package or reconciling its services.
`dim mirrors ensure` validates the selected configuration; workspace attachment
happens on the next lifecycle or exec operation.

For independently operated services, including a NAS or another cache host,
create this exact URL-only catalog and select it:

```json
{
  "schemaVersion": 1,
  "endpoints": {
    "docker": "https://registry-cache.example/",
    "npm": "https://npm-cache.example/",
    "pypi": "https://pypi-cache.example/root/pypi/+simple/",
    "apt": "http://apt-cache.example:3142/"
  }
}
```

```sh
dim mirrors configure /path/to/package-caches.json
dim mirrors ensure
```

All four URLs are required. Unknown fields, inline credentials, query strings
and fragments are rejected. HTTP and HTTPS endpoints are supported; the APT
proxy endpoint must have a root path. Package repository base paths remain part
of the npm/PyPI URL. This catalog contains no commands, templates, images or
runtime policy. The operator owns endpoint availability and host trust settings.

`configure` saves a private copy at
`$DIM_STATE_ROOT/plugins/host-mirrors/config.json`. That explicit selection takes
precedence over the server-published catalog. Remove that private selection to
resume using the host catalog. With SSH host selection, paths and configuration
belong to the selected host. Changing server placement or moving a service to a
NAS requires updating URLs, rather than changing consumer deployment logic.

## Workspace and nested-container defaults

Each running workspace receives a private relay on its runtime's host gateway.
Its guest configuration contains relay URLs, not cache-server credentials. The
runtime must provide a private host gateway and the DIM guest helpers, Node and
sudo environment. Sysbox containers and the optional VM runtime use this same
client boundary.

The workspace's own nested Docker engine uses the Docker Hub mirror. Guest host
entries suppress default direct Hub fallback. npm gets a delimited DIM default
in `~/.npmrc`, preserving unrelated entries, scoped registries, credentials and
an explicit user registry. Existing symlinks, non-owned files and other user-managed
`~/.npmrc` objects are left untouched rather than followed or replaced. pip gets a global `/etc/pip.conf` default; user and
project configuration and explicit environment settings retain precedence.
Existing explicit global index/trust settings and unrelated global npm/pip
settings are preserved.

A persistent guest-only Docker API adapter gives new nested containers:

- Read-only APT and Docker daemon configuration files.
- A read-only npm global configuration at `/run/dim-caches/npmrc`, with
  `NPM_CONFIG_GLOBALCONFIG` set only when the caller did not supply it.
- A read-only `/etc/pip.conf`, without forcing `PIP_CONFIG_FILE` over user config.
- Docker Hub fallback host entries, preserving explicit caller overrides.

Existing mounts at these destinations are retained. npm project/user config and
pip user/env choices can override defaults. Other Docker operations, binary
build bodies, streaming responses and bidirectional upgrades pass through
without parsing their bodies. The adapter sees only the workspace's nested
engine, never a host Docker socket. No global `HTTP_PROXY` or `HTTPS_PROXY` is
injected, so unrelated internal HTTP services keep ordinary routing.

Mount injection covers new nested run consumers. BuildKit package installs need
explicit reviewed build inputs; this plugin does not pretend that run-time
mounts configure arbitrary Dockerfile build stages. Workspace root can override
guest settings: these are cache defaults and bypass suppression, not packet-level
egress isolation.

## Relay scope and lifetime

The relay accepts fixed public-cache reads, stripping Authorization, Cookie and
arbitrary proxy headers before forwarding. Docker reads are limited to
`GET`/`HEAD /v2/...`. npm metadata/tarballs and PyPI simple-index/artifact links
stay within the configured cache repository; metadata is rewritten to retain
relay URLs, and upstream/CDN escapes are rejected. Publishing and arbitrary
forward-proxy requests are not enabled.

APT accepts HTTP package URLs only for `deb.debian.org`, `security.debian.org`,
`archive.ubuntu.com`, `security.ubuntu.com` and `ports.ubuntu.com`. CONNECT,
private/metadata URLs, alternate target ports and embedded credentials are
rejected. HTTPS APT sources remain direct; there is no TLS interception. Other
APT repositories need a reviewed adapter change or explicit project transport.

Relays are fenced by immutable core workspace UUIDs. Private mode-0600 state and
an OS lock prevent conflicting listeners. Pausing denies requests and closes
active transfers; resume retains relay URLs. Discard or name reuse closes old
listeners. An endpoint update changes private upstream targets while retaining
the workspace's relay URLs. Guest settings and service registration survive
recreate in persistent home storage. Cache data belongs to its independently
operated server and outlives workspace discard.

Connection counts, headers, request size, upstream header latency and idle
transfer time are bounded. Large active layers stream with backpressure. APT
proxy failures propagate; default direct Docker Hub fallback is suppressed.
These relays serve public cache data on a private network, not confidential
per-workspace repositories.

## Managed CI and verification

The optional managed composition receives the same selected cache URLs and
plugin-owned read-only client files. The CI execution core does not select cache
images, deploy servers or interpret package-manager syntax. Host credentials
are absent from job configuration.

`tests/plugins/host-mirrors/test/autoAttachment.test.ts` exercises actual Unix
Docker API forwarding, streaming/binary upgrades, relay request restrictions and
workspace lifetime fencing. `guestClients.test.ts` covers four-endpoint payloads
and explicit npm/pip and nested-container overrides.

Disposable runtime gates live at
`verification/scripts/auto-host-mirrors-smoke.mts` and
`verification/scripts/package-cache-smoke.mts`. They use random resource names;
never point them at installed cache services or existing data volumes. Read each
script's prerequisites and usage before running it.
