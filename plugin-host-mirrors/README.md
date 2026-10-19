# `@slop-lab/dim-plugin-host-mirrors`

Optional host-owned Docker Hub and APT caching for ordinary Git workspaces and
managed CI. The base feature needs only `dim-core`; `dim-managed` is an optional
peer for shared CI. Exact reviewed image digests and cache ownership live in
this plugin. Projects do not select host packages or cache images.

```sh
dim installer install plugin '@slop-lab/dim-plugin-host-mirrors@0.10.0'
dim mirrors ensure
```

Install the same exact plugin version as DIM. Once installed, its host workspace
ready hook automatically reconciles the caches and attaches them to running
workspaces, including existing workspaces on their next lifecycle/exec operation.
No per-Project proxy settings, controller restart, or host OS package installation
is needed. The selected runtime must provide a private host gateway and the DIM
guest helper/Node/sudo environment. Container workspaces use Sysbox; the optional
VM runtime supplies its managed bridge gateway through the same host port.

## Default routing

Each workspace gets a private host relay bound to its runtime bridge gateway.
The relay forwards only fixed public cache reads; no host Authorization, Cookie
or arbitrary proxy headers reach the cache. Registry requests are limited to
`GET`/`HEAD /v2/...`. The APT proxy accepts HTTP package URLs only for reviewed
standard Debian/Ubuntu hosts: `deb.debian.org`, `security.debian.org`,
`archive.ubuntu.com`, `security.ubuntu.com`, and `ports.ubuntu.com`.
It rejects CONNECT, private/metadata URLs, alternate ports and embedded credentials.
HTTPS APT sources remain direct; there is no TLS interception. Other HTTP APT
repositories require an operator-reviewed provider change or an explicit
Project transport choice.

The workspace's own nested Docker engine uses the host registry mirror, and
its guest hosts file blocks default direct Docker Hub fallback. A persistent
guest-only Docker API shim applies these defaults to new nested containers:

- A read-only APT configuration at `/etc/apt/apt.conf.d/99dim-mirrors`.
- A read-only Docker daemon configuration at `/etc/docker/daemon.json`, so a
  nested DinD environment inherits the registry mirror.
- Docker Hub fallback host entries, preserving unrelated names and explicit
  caller overrides.

The shim forwards other Docker API operations, binary build payloads, streaming
wait responses and bidirectional upgrades without parsing their bodies. It
never receives a host Docker socket. Workspace root remains untrusted and can
intentionally override guest settings; this is default cache routing and bypass
suppression, not strong packet-level egress isolation.

No global `HTTP_PROXY`/`HTTPS_PROXY` variable is added to application containers.
Internal HTTP services retain their ordinary routing. Automatic APT injection
covers nested Debian/Ubuntu run consumers. BuildKit `RUN apt` needs an explicit
Project build input or reviewed build configuration; this plugin does not add
broad build proxy variables that silently redirect unrelated internal HTTP.

## Lifetime and ownership

Host cache containers, network and volumes retain random ownership identities.
Existing foreign names or unexpected runtime configuration are rejected rather
than adopted or deleted. Cache image replacement retains owned cache data.
The canonical cache state directory is `DIM_HOST_MIRRORS_STATE_ROOT`, otherwise
`DIM_STATE_ROOT/plugins/host-mirrors` under the usual DIM/XDG state root.

A separate detached relay lifetime follows each immutable core workspace UUID.
Private mode-0600 configuration and an OS lock prevent conflicting listeners.
Pausing a workspace denies requests and closes its active transfers while
retaining stable URLs for resume. Discard/name reuse closes its listeners and
releases the lock. The relay validates current workspace identity on requests
and watches lifecycle changes. Cache address replacement updates only private
upstream targets, retaining the workspace's existing relay URLs; already-running
APT consumers keep working. Guest services and configuration survive workspace
recreate through the normal persistent home/service registry.

Host relays carry no host package-manager or registry credentials. They are
public-cache read services on the private host network, not per-workspace
confidential repositories. They bound connection count, headers, request size,
upstream header latency and idle transfer time; large active image layers stream
with backpressure. An unavailable APT cache fails through the configured proxy;
an unavailable Docker mirror does not silently switch to default direct Hub.

## Shared CI

The optional managed composition selects the same provider. It receives the
registry routing plus generic read-only job files whose contents are owned by
this plugin, including the standard APT proxy configuration. The execution core
does not interpret APT syntax or select concrete cache images. Job files contain
only public cache addresses, never host credentials.

## Verification

`tests/plugins/host-mirrors/test/autoAttachment.test.ts` exercises actual Unix
Docker API forwarding, delayed streaming headers, binary upgrades/half-close,
fixed public cache endpoints, credential stripping, APT SSRF denial and immutable
workspace lifetime fencing.

Run the explicit disposable real consumer gate with an already built DIM image:

```sh
pnpm --dir plugin-host-mirrors build
pnpm --dir tests exec tsx ../verification/scripts/auto-host-mirrors-smoke.mts WORKSPACE_IMAGE
```

It creates random owned cache containers/volumes and a Sysbox workspace, verifies
nested Debian and Ubuntu cold and warm `.deb` bytes with cache Internet access removed,
forces cache replacement to a different IP while consumers remain running,
prunes nested images and refetches them from an Internet-disconnected warm registry, and
checks APT outage plus Docker Hub fallback suppression. It cleans up its owned
resources and does not stop or reconfigure installed mirror services.
