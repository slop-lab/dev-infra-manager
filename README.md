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
```

After the repositories materialize, explicitly bootstrap the configured user
tool, then launch the configured agent through the Project-owned task contract:

```bash
dim workspace run dim-dev tool-setup \
  && dim workspace run dim-dev agent
```

The `tool-setup` mapping runs the reviewed local setup utility. It creates
explicit user-level state that persists in the agent home, including a
contract-versioned launcher manifest. The `agent` mapping accepts that state
only when its contract version, launcher name, pinned tool identity and
version, and executable path match the Project's reviewed configuration. The
reviewed Project lifecycle does not install or authenticate user tools
automatically; this setup is not `.dim/setup.sh` lifecycle work. DIM core knows
neither task's tool-specific mapping. Existing agent homes are not upgraded
automatically. After adopting a reviewed Project change that selects new setup
bytes or tool versions, rerun `tool-setup` explicitly before launching `agent`.

Launch the opt-in authenticated Web interface separately:

```bash
dim workspace run dim-dev bash -- /workspace/scripts/opencode-web.bash
```

For a separate browser UI, pass its source origin, not the destination DIM
external URL:

```bash
dim workspace run dim-dev bash -- -c \
  'export OPENCODE_WEB_CORS_ORIGINS="$1"; exec bash /workspace/scripts/opencode-web.bash' \
  bash '["https://remote-web.example"]'
```

The launcher prints the external URL, username, and restricted credential-file
path without printing the password. It stores the credential and owned-process
identity in the persistent user home, and reuses a
healthy matching process and URL on retry. The setup command above remains
non-launching. The agent receives `DIM_DEVELOPMENT_URL_SOCKET` and the common
`dim-development-service` helper from the reviewed workspace image. The helper
lets the launcher choose its own loopback port, creates or reuses the external
URL, and routes that URL through a fixed gateway selected by the lifecycle.
The lifecycle constrains the gateway to ingress `https-ts`, protocol `http`,
and container path `["agent-dind","dim-agent"]`; it does not know which tool or
local port uses the gateway. The existing `DIM_EXTERNAL_URL_SOCKET` remains an
ingress-only generic capability for its existing clients and continues to
permit both `https-ts` and `http-ts`. Neither socket exposes a controller grant
or raw host secret. Read the reported mode-`0600` file explicitly when the
browser asks for Basic Auth; its first line is the username and its second is
the password. The launcher always allows `https://localhost:4096` and reads
`OPENCODE_WEB_CORS_ORIGINS` as a JSON array of additional exact HTTP or HTTPS
origins, defaulting to `[]`. It normalizes, deduplicates, and sorts them, and
rejects invalid values, credentials, paths, queries, fragments, and `*` before
creating state.
The pinned OpenCode release does not support `*` as a wildcard CORS origin.
OpenCode may merge launcher origins with its own configured or built-in
origins.

OpenCode's CORS response headers pass through the external URL route. A
cross-origin browser client must still send the reported Basic Auth credential
in the `Authorization` header. The same port and canonical origin list reuse
the healthy owned process; a changed port or list restarts only that process
while retaining its credential, external URL, and shared gateway. Allow only
trusted client UI origins. The reviewed
inner-container launch publishes only the common gateway port at the same
stable port in `agent-dind`. The mapping survives inner-agent recreation, so
the existing external URL relay remains valid. Replacing OpenCode with another
development service does not require a `.dim` change.

The host must have the HTTPS `https-ts` ingress configured before Web launch.
The executable Caddy/Cloudflare pattern is
[`examples/projects/configure-web-ingress.bash`](../examples/projects/configure-web-ingress.bash).
Selecting another ingress also requires a reviewed change to the development
URL proxy's `--ingress` allowlist; changing only the launcher cannot widen the
socket.

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

The service records its identity in a mode-`0600`, schema-1
`service-owner.json` that binds its PID, process start ticks, `argv`,
executable, working directory, and socket inode. The obsolete `service.pid`
format is rejected before mutation, not migrated, by enabled and disabled
setup and by teardown. The service has the stable working directory
`/tmp/dim-qemu-verification`, while its scripts retain immutable Project-root
provenance and each launcher receives `/workspace` as both its source root and
working directory. Setup and teardown replace or retire a service and its
artifacts only when that complete identity still matches. Malformed,
ambiguous, or replaced ownership fails closed: lifecycle cleanup neither
signals nor deletes artifacts it cannot prove belong to that service. With no
owner record, startup waits for a bounded period without signalling a process.

Snapshot directory traversal is streamed to keep large input trees bounded in
memory. Cancellation is bounded: it stops the verified process group with
`TERM`, followed by `KILL` after four seconds if needed. Up to 16 clients may
follow run events at once; a follower that cannot accept events without
backpressure is disconnected rather than allowed to stall the service. A
snapshot-cleanup failure or permanent listener error closes admission, exits
nonzero after bounded termination of any active process group, and retains
ownership, run, and snapshot evidence. Run cleanup chooses one owner before
snapshot removal starts. When fatal shutdown wins first, it skips removal and
preserves the exact snapshot. When ordinary cleanup wins first, a later fatal
error awaits that already-committed removal, retains the remaining run and
service evidence, and does not claim that the snapshot being removed remains
intact. Shutdown is serialized: the first graceful shutdown continues its
cleanup even if a later runtime error upgrades the exit to `1`; later signals
reuse that same shutdown. Fatal listener close safeguards and restores a
foreign public socket that replaced the owned pathname while retaining the
owned lease and other evidence.

The canonical Project runs its development agent as UID 0 only inside a
private rootless `agent-dind`. The daemon adopts the workspace checkout's
non-root UID/GID, so inner UID 0 maps to that owner rather than to root in the
trusted workspace or host. Docker authority is confined to that inner
rootless boundary. Selecting
the `secure` workspace profile starts a separate `secure-dind` daemon with its
own storage and without agent home, source, or Git credential mounts for
Project-defined secret-bearing workloads.

Agent and secure rootless DinD startup repairs the root ownership and setuid
mode of `newuidmap` and `newgidmap`, but never recursively changes persistent
agent-home or Docker-data ownership, content, or modes. An empty persistent
root is initialized for its configured rootless UID. A populated root with an
incompatible top-level owner, or an agent home with an incompatible mode,
fails startup with the observed and expected identity instead of attempting an
implicit migration. Recreate or restore incompatible state explicitly; the
lifecycle does not remove stale runtime state from persistent Docker storage.

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
just prepare-local
```

By default, preparation resolves and pins the latest commit from each production
repository's default branch. To prepare an explicitly reviewed source set
instead, provide any or all of the corresponding full commits:

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

To install the prepared local packages and restart the controller in one
ordered operation, use `just install-local-control-plane`. It skips the
restart if installation fails; the separate recipes remain available for
independent review or scheduling.

Preparation requires Git, Docker with the Buildx plugin, Node.js 24 or 26, and
pnpm 10. Installation requires npm directly or through mise; it does not trust
the existing DIM installer facade to install the candidate.
Preparation clones only `core`, `plugin-dns-cloudflare`, and
`plugin-external-urls`; no workspace or `*-development` checkout is used. The
caller may set `DIM_SOURCE_CORE_COMMIT`,
`DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT`, and
`DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT` to reviewed full commits, each exactly
40 lowercase hexadecimal characters. An omitted input resolves to the remote
repository's current default-branch `HEAD`; branches, tags, and abbreviated
commits are rejected as explicit inputs. Each resolved object is fetched,
checked out detached, verified against the resulting full `HEAD`, and printed
before dependency installation. A split `root.git` origin resolves sibling
repository URLs; a canonical monorepo origin uses that same URL for all three
repositories. Set `DIM_SOURCE_ROOT_URL` or
`DIM_SOURCE_REPOSITORY_BASE_URL` only to override this URL resolution. The local
package version includes a deterministic SHA-256 digest of the fixed,
repository-name/full-commit record set and the checked-in aggregate pnpm lock
digest, so changing any production repository or the reviewed dependency graph
changes the shared version identity. Preparation copies that lock into an
isolated pnpm workspace containing only the cloned production packages and
installs with `--frozen-lockfile`, so unpublished internal versions link to the
exact resolved source set and a surrounding development checkout cannot affect
dependency installation.

The preparation recipe tags the trusted workspace image with the package
bundle's complete aggregate local version, built from the same
`.local/production-source` snapshot, and records that tag, full source SHAs, a
digest of the package bundle, and the resulting immutable image ID in ignored
`.local` state. The install recipe validates preparation, stages the exact
installer tarball in a temporary directory outside the prepared bundle, and
uses that target facade to install the CLI and enable the prepared DNS
Cloudflare and External URLs plugins. An older standalone facade cannot
retroactively enforce compatibility checks introduced by the candidate, so it
is never used for the install operation. Mise may supply Node.js and npm, but
does not select installer logic. The recipe preserves other enabled plugins
and is safe to repeat. It does not rebuild or restart anything. Missing, stale,
or mismatched state fails before installation, including when package bytes or
the image tag changed after preparation.
`just restart-controller` is the separate, explicit controller-restart stage.
A failed preparation leaves no readiness marker. Preparation and installation
hold the same exclusive lock under `.local`.
Preparation builds under a temporary image tag and replaces the versioned tag
only after every other output is ready, so a failed attempt leaves the previous
versioned image untouched. Neither recipe replaces existing workspaces;
recreate them explicitly when they need the refreshed image. Cloned sources
and package tarballs remain under `.local/production-source` and
`.local/dim-packages` for inspection; the next preparation replaces their
contents.
