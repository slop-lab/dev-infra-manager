# DIM self-development root

This is the minimal, security-sensitive root repository for DIM's own Project.
The reviewed [`.dim`](.dim) lifecycle bootstraps the private development
runtime and assembles the independently managed repositories under
`/workspace`. Ordinary source, tests, tooling, examples, and specifications do
not live in this repository.

[`.dim/repos.yml`](.dim/repos.yml) is the reviewed repository catalog. The
lifecycle clones the `development` repository at `/workspace` and the other
registered repositories as siblings (`core`, `core-development`, plugin
source and development pairs, `verification`, `examples`, and
`specification`). Existing agent-controlled checkouts are never modified by
the trusted outer lifecycle. New checkouts use the runtime manifest's resolved
commit SHA, so candidate refs and moving branches cannot change the materialized
repository set after DIM creates the snapshot.

The catalog connects these 11 independent repositories to GitLab development
upstreams, each on `main`. DIM-managed Gitea is the internal review host.
`dim repo publish dim` publishes managed heads only to those GitLab
upstreams. Publishing the integrated canonical repository and creating a
release on GitHub are separate actions performed by a trusted maintainer.

The reviewed [QEMU cache hook](.dim/ci/qemu-cache.bash) seeds the pinned Ubuntu
image used by DIM's nested installer verification into the Project-scoped
runner base. It runs only while Packer builds that base; pull-request jobs see
the result through their disposable overlay and cannot modify the persistent
cache.

Create the split self-development Project from the root branch:

```bash
dim project create dim \
  --bootstrap-git-url https://gitlab.com/slop-lab/dim/root.git \
  --bootstrap-git-ref main \
  --apply-repos
dim workspace create dim dim-dev
dim workspace run dim-dev codex
```

When the workspace was created with KVM, the agent can run the reviewed local
QEMU gate without receiving `/dev/kvm` or a QEMU binary itself:

```bash
node project/.dim/qemu-client.mjs run
node project/.dim/qemu-client.mjs run --input fixtures=/workspace/local-fixtures
node project/.dim/qemu-client.mjs probe
```

Additional inputs must resolve beneath `/workspace`, and duplicate names are
rejected. The service synchronously claims one run before reading its request
body or awaiting filesystem work. While that claim remains exclusive, it
copies inputs without following symlinks into immutable service-owned
snapshots before launch. A snapshot failure starts no child process. Successful
snapshots appear in the guest under `/mnt/dim-inputs/NAME`; they are not host
bind mounts and cannot escape the agent-visible source boundary. `status`,
`follow`, and `cancel` subcommands control the single workspace-scoped run.

The canonical Project runs its development agent as UID 0 only inside a
private rootless `agent-dind`. The daemon adopts the workspace checkout's
non-root UID/GID, so inner UID 0 maps to that owner rather than to root in the
trusted workspace or host. Docker authority is confined to that inner
rootless boundary. Selecting
the `secure` workspace profile starts a separate `secure-dind` daemon with its
own storage and without agent home, source, or Git credential mounts for
Project-defined secret-bearing workloads.

The root lifecycle clones missing registered managed repositories into
`/workspace` using the runtime catalog. It never runs Git against an
existing agent-controlled checkout; agents fetch, switch, and update those
repositories from inside their private development runtime. Run local source
checks from the assembled development workspace:

```bash
pnpm install --frozen-lockfile
just check-source
```

## Connect to the agent with OpenSSH

The generic `ssh-proxy` Project task carries an unmodified SSH byte stream to
port 22 inside the agent container. It accepts no arguments and never allocates
a TTY. Add a public key to the persistent agent home before connecting:

```bash
dim workspace run dim-dev bash -lc \
  'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' \
  < ~/.ssh/id_ed25519.pub
```

The image supervises a root-owned foreground `sshd` master process as its
default workload, so SSH returns with the agent when the existing container is
stopped and started. Authenticated sessions use the `dim-agent` account with a
fixed UID 1000. Ordinary canonical tasks still run as UID 0 inside the private
rootless daemon, where that identity maps to the non-root workspace owner. SSH
startup instead grants `dim-agent` recursive and default ACL access to the
workspace and a scoped ACL on the private Docker socket. This gives SSH
sessions practical workspace and Docker authority without changing checkout
ownership or making it world-writable. The account's passwd home is
`/home/dim-agent`, backed by the persistent agent-home volume, so its
`authorized_keys` and other home state survive agent container recreation.

Each SSH session receives a server-controlled environment from a root-owned,
ephemeral file under `/run/dim-agent`. The explicit allowlist includes the
private Docker endpoint, Git identity and credential settings, and constrained
External URL and QEMU endpoints. Client environment requests cannot override
it, and it is not persisted in the agent home. Git trusts only `/workspace`
and `/workspace/*` as safe directories. `DOCKER_HOST` names the private nested
socket at `/run/docker.sock`, never a host or Project-runtime Docker socket.
The constrained External URL and QEMU sockets are the only other runtime
control endpoints made available to these sessions.

Before accepting a host key, obtain its fingerprint through the existing
trusted Project task path:

```bash
dim workspace run dim-dev bash -lc \
  'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
```

Accept the fingerprint shown by the OpenSSH client only when it matches this
output.

Configure any OpenSSH client with a `ProxyCommand` that invokes the task:

```sshconfig
Host dim-dev-agent
    HostName dim-dev-agent
    User dim-agent
    RequestTTY no
    ProxyCommand dim workspace run dim-dev ssh-proxy
```

Then connect with `ssh dim-dev-agent`. This transport can support shells,
editors, file transfer, or a Codex development workflow without publishing an
SSH port from either container.

The proxy itself provides no authentication or authorization; `sshd` and the
configured public keys provide those controls. Root authentication is disabled
even with a valid configured key. A trusted key carries full agent authority:
it can change workspace and home content, use the private nested Docker daemon,
push with the agent's bounded Git credentials, and call the constrained agent
endpoints. It grants no host or Project-runtime authority. Host keys persist
across stop/start of the existing container but change when setup recreates it.
Verify changed host keys rather than disabling strict host-key checking. To
retain the agent-home volume across discard, use
`dim workspace discard dim-dev --keep-volume`; the default discard removes it.

## Install an unreleased source build on the host

From a host checkout of this root repository, clone the production source
repositories from the same Git host, build and package them, and rebuild the
trusted workspace image with Docker Buildx:

```bash
DIM_SOURCE_CORE_COMMIT="$REVIEWED_CORE_COMMIT" \
DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT="$REVIEWED_DNS_PLUGIN_COMMIT" \
DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT="$REVIEWED_EXTERNAL_URLS_PLUGIN_COMMIT" \
  just prepare-local
```

Review the resolved commits and prepared outputs, then install that exact
package and image set before explicitly restarting the controller:

```bash
just install-local
just restart-controller
```

Preparation requires Git, Docker with the Buildx plugin, Node.js 24 or 26, and
pnpm 10. Installation also requires the existing DIM installer facade.
Preparation clones only `core`, `plugin-dns-cloudflare`, and
`plugin-external-urls`; no workspace or `*-development` checkout is used. The
caller must set `DIM_SOURCE_CORE_COMMIT`,
`DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT`, and
`DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT` to reviewed full commits, each exactly
40 lowercase hexadecimal characters. Branches, tags, abbreviated commits, and
omitted inputs are rejected. Each exact object is fetched, checked out detached,
verified against the resulting full `HEAD`, and printed before dependency
installation. A split `root.git` origin resolves sibling repository URLs; a
canonical monorepo origin uses that same URL for all three repositories. Set
`DIM_SOURCE_ROOT_URL` or `DIM_SOURCE_REPOSITORY_BASE_URL` only to override this
URL resolution. The local package version includes a deterministic SHA-256
digest of the fixed, repository-name/full-commit record set, so changing any
production repository changes the shared version identity. Preparation installs
each cloned repository with its reviewed `pnpm-lock.yaml` and
`--frozen-lockfile`, so package manifest and lockfile drift fails before any
artifacts are prepared.

The preparation recipe loads the exact
`dev-infra-project-workspace:latest` image from the same
`.local/production-source` snapshot and records full source SHAs, a digest of
the package bundle, and the resulting image ID in ignored `.local` state. The
install recipe does not rebuild or restart anything. Missing, stale, or
mismatched state fails before installation, including when package bytes or
the image tag changed after preparation. `just restart-controller` is the
separate, explicit controller-restart stage. A failed preparation leaves no
readiness marker. Preparation and installation hold the same exclusive lock
under `.local`.
Preparation builds under a temporary image tag and replaces the canonical tag
only after every other output is ready, so a failed attempt leaves the previous
canonical image untouched. Neither recipe replaces existing workspaces;
recreate them explicitly when they need the refreshed image. Cloned sources
and package tarballs remain under `.local/production-source` and
`.local/dim-packages` for inspection; the next preparation replaces their
contents.
