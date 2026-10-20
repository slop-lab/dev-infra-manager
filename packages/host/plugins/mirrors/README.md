# `@slop-lab/dim-host-plugin-mirrors`

Connect ordinary Git workspaces and optional CI workers to selected shared
package caches. Docker Hub, npm, PyPI and APT adapters are included; installed
host plugins can add reviewed protocol adapters. This optional **client** plugin configures consumers;
it does not install, start, replace or own cache servers. It requires `@slop-lab/dim-host-core`;
CI workers consume the host execution-routing capability.

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-mirrors@0.10.0'
```

## Select cache URLs

A cache host may independently install the optional
[`cache-server`](../cache-server/README.md) plugin:

```sh
dim installer install plugin '@slop-lab/dim-host-plugin-cache-server@0.10.0'
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

Configure only the protocols you need: between one and 32 endpoint entries are
accepted. For example, `{"schemaVersion":1,"endpoints":{"npm":"https://npm-cache.example/"}}`
selects npm alone. Each key must identify an included or enabled installed adapter.
Unknown catalog fields, inline credentials, query strings and fragments are
rejected. HTTP and HTTPS endpoints are supported; the APT endpoint must
have a root path. Package repository base paths remain part of the npm/PyPI URL. This catalog contains no commands, templates, images or
runtime policy. The operator owns endpoint availability and host trust settings.

`configure` saves a private copy at
`$DIM_STATE_ROOT/plugins/host-mirrors/config.json`. That explicit selection takes
precedence over the server-published catalog. Remove that private selection to
resume using the host catalog. With SSH host selection, paths and configuration
belong to the selected host. Changing server placement or moving a service to a
NAS requires updating URLs, rather than changing consumer deployment logic.

## Installed protocol adapters

Adapter code belongs to an explicitly installed and enabled host plugin. URL
catalogs select endpoints; they cannot supply module paths, commands, JavaScript,
request transforms or templates. Installing a server does not install a new
consumer protocol, and adding an adapter never deploys a server.

A host plugin registers its local adapter module using the public SDK:

```ts
import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/workspace";
import { mirrorAdapterExtension } from "@slop-lab/dim-host-plugin-mirrors/adapter";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "artifact-cache-client",
  extensions: [
    mirrorAdapterExtension("artifacts", new URL("./adapter.js", import.meta.url))
  ]
};
```

The referenced module exports `mirrorAdapter`, typed as `MirrorAdapter` from
`@slop-lab/dim-host-plugin-mirrors/adapter`. Its `kind` must match the registration.
For a reviewed Cargo implementation the registration would instead use
`mirrorAdapterExtension("cargo", new URL("./adapter.js", import.meta.url))`;
this is registration syntax, not a bundled Cargo implementation.

| Adapter member | Responsibility |
| --- | --- |
| `kind`, `description`, `commands` | Identify the protocol and describe its consumer commands |
| `normalizeEndpoint(value)` | Validate and normalize that protocol's operator-selected endpoint |
| `target(path, endpoint)` | Return an allowed upstream URL, or deny the request with `undefined` |
| `requestPath(target)` | Optional protocol-specific upstream request path |
| `responseHeaders` | Explicit additional response headers needed by that protocol |
| `metadata.accepts` / `metadata.rewrite` | Identify and rewrite bounded metadata, including keeping artifact links within the selected repository |
| `clientConfiguration(endpoint)` | Produce read-only consumer files, environment defaults and optional Docker daemon settings or blocked hostnames |
| `guestModuleUrl` | Identify the installed self-contained guest client module |

For an artifact protocol, `target` must restrict reads to its reviewed artifact
namespace; a generic forward proxy is not an adapter. Metadata rewrites must
reject unexpected upstream or CDN destinations rather than leak host-side
credentials or let a guest select arbitrary hosts. Adapter modules are trusted
host code, so installation requires the same review as other host plugins.
Duplicate kinds, file destinations, environment defaults or Docker daemon
contributions are rejected rather than silently choosing an owner.

The guest module exports `clientConfiguration(endpoint)`,
`configureSystem(endpoint)` and, when needed, `configureUser(endpoint)`.
Optional `removeUser(endpoint)` and `removeSystem(endpoint)` hooks undo its
own defaults. Supply removal hooks whenever an adapter writes persistent client
settings: without them, deselection does not undo that adapter's configuration
and the operator must remove its settings explicitly. A guest module that
provides nested configuration files should also export
`retiredClientConfiguration(endpoint): MirrorClientConfiguration`. This returns
neutral contents for every previously mounted target. The included clients use
an empty/default npm or pip file, APT `DIRECT`, and an empty Docker daemon
object. Missing custom retirement support is reported; existing mounts are not
silently claimed to be removed.
`clientConfiguration` returns `MirrorClientConfiguration` from the same SDK;
its definition can be imported with `import type`. Guest modules must be
self-contained compiled ESM: runtime imports may use Node built-ins only. Their
source is delivered into the selected workspace, where user and system hooks
run in their corresponding guest contexts. No host Docker socket is exposed.

Host-side CI configuration and nested-container defaults consume the same
protocol-owned `clientConfiguration`. The common guest runner handles module
updates, safe file publication and service startup; it does not interpret npm, pip, APT
or future protocol syntax. A future adapter therefore adds its own reviewed
request and client implementation, rather than extending a catalog policy DSL.

## Workspace and nested-container defaults

Each running workspace receives a private relay on its runtime's host gateway.
Its guest configuration contains relay URLs, not cache-server credentials. The
runtime must provide a private host gateway and the DIM guest helpers, Node and
sudo environment. Sysbox containers and the optional VM runtime use this same
client boundary.

Only selected adapters apply their defaults. With Docker selected, the
workspace's nested engine uses its Docker Hub mirror and guest host entries
suppress default direct Hub fallback. With npm selected, it gets a delimited DIM default
in `~/.npmrc`, preserving unrelated entries, scoped registries, credentials and
an explicit user registry. Existing symlinks, non-owned files and other user-managed
`~/.npmrc` objects are left untouched rather than followed or replaced. pip gets a global `/etc/pip.conf` default; user and
project configuration and explicit environment settings retain precedence.
Existing explicit global index/trust settings and unrelated global npm/pip
settings are preserved.

A persistent guest-only Docker API adapter gives new nested containers:

- Read-only APT and Docker daemon configuration files.
- A read-only npm global configuration at `/etc/npmrc`, with
  `NPM_CONFIG_GLOBALCONFIG` set only when the caller did not supply it.
- A read-only `/etc/pip.conf`, without forcing `PIP_CONFIG_FILE` over user config.
- Docker Hub fallback host entries, preserving explicit caller overrides.

Adapter-generated bind source names depend on their target path, not the
adapter's file ordering. These owned regular files update in place after
no-follow, ownership and link checks, so existing read-only bind mounts see
refreshed URLs through the same inode. Modules and active-client records still
use atomic replacement. Retiring a client writes its neutral configuration into
its existing bind sources rather than leaving a dead relay URL behind.

Existing mounts at these destinations are retained. npm project/user config and
pip user/env choices can override defaults. Other Docker operations, binary
build bodies, streaming responses and bidirectional upgrades pass through
without parsing their bodies. The adapter sees only the workspace's nested
engine, never a host Docker socket. No global `HTTP_PROXY` or `HTTPS_PROXY` is
injected, so unrelated internal HTTP services keep ordinary routing.

Mount injection covers new nested run consumers. BuildKit package installs need
explicit reviewed build inputs; this plugin does not pretend that run-time
mounts configure arbitrary Dockerfile build stages. Existing nested process environments and Docker `ExtraHosts` are container
creation settings: they require recreating that nested container to remove them.
Configuration file updates do not reload arbitrary daemons inside application
containers. Workspace root can override
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
recreate in persistent home storage. The guest records each active client module
and endpoint. When a protocol is deselected or its endpoint/module changes, its
previous module's removal hooks run before current clients are configured.
The included adapters remove matching DIM blocks or exact managed file content;
operator replacements remain intact. Docker tracks its added registry entries
and previous mirror configuration so removal preserves pre-existing policy.
Changing endpoint selection applies this cleanup on the next host preparation;
disabling the whole host plugin does not run an uninstall operation inside guests.
Cache data belongs to its independently
operated server and outlives workspace discard.

Connection counts, headers, request size, upstream header latency and idle
transfer time are bounded. Large active layers stream with backpressure. APT
proxy failures propagate; default direct Docker Hub fallback is suppressed.
These relays serve public cache data on a private network, not confidential
per-workspace repositories.

## CI workers and verification

The host execution-routing provider supplies CI workers with the same selected
cache URLs and plugin-owned read-only client files. Without configured cache URLs
it returns no route; multiple configured routing providers are rejected. The CI execution core does not select cache
images, deploy servers or interpret package-manager syntax. Host credentials
are absent from job configuration.

`tests/host/plugins/mirrors/autoAttachment.test.ts` exercises actual Unix
Docker API forwarding, streaming/binary upgrades, relay request restrictions and
workspace lifetime fencing. `guestClients.test.ts` covers generic module delivery,
code refresh, protocol-owned settings and explicit npm/pip and nested-container
overrides.

Disposable runtime gates live at
`scripts/checks/auto-host-mirrors-smoke.mts` and
`scripts/checks/package-cache-smoke.mts`. They use random resource names;
never point them at installed cache services or existing data volumes. Read each
script's prerequisites and usage before running it.
