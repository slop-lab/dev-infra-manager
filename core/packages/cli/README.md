# @slop-lab/dim-cli

`dim` creates persistent, isolated development workspaces around a
review-controlled Git repository. It is intended for AI-assisted development
where agent changes must be pushed and reviewed before they reach protected
branches or secret-bearing environments.

## How DIM models a project

A DIM **Project** is lightweight metadata:

- a name and a dedicated `dim-<project>` namespace in DIM's managed Gitea;
- one required **root repository** and an optional branch ref;
- any additional repositories that belong to the Project.

Each **workspace** mounts an immutable snapshot of the reviewed root repository. The root repository's
optional `.dim/setup.sh`, `.dim/entrypoint.sh`, and Docker Compose
configuration own all mutable checkouts and nested containers. A repository
does not need to correspond one-to-one with a container. DIM therefore tracks
one root ref instead of prescribing a multi-repository runtime layout. When no
root ref is configured, DIM resolves the repository's symbolic `HEAD`;
workspace creation fails if the repository has no `HEAD`.

A running workspace is never changed automatically when the Project changes.
`dim workspace start`, `dim workspace restart`, and `dim workspace update`
select reviewed root bytes and run setup. Project code decides how to reconcile
its persistent mutable data.

## Requirements

- A Linux host with a systemd user manager. macOS, Windows, and Docker Desktop
  hosts are not supported.
- Node.js 24 or 26.
- Git and a working Docker CLI/daemon. DIM always uses Docker to manage the
  outer workspace container, regardless of the selected backend.
- The Sysbox workspace backend and its registered `sysbox-runc` Docker runtime.
- Docker Buildx, used by the explicit workspace-image build command.

The installed CLI contains the trusted image build assets. After installing a
host backend, build the exact image selected by this CLI release without a
source checkout:

```bash
dim workspace image build
dim workspace image status
```

The build uses the invoking user's UID and GID and defaults to
`dev-infra-project-workspace:<installed DIM package version>`. An explicit
tagged `DIM_WORKSPACE_IMAGE` is the only override. Image IDs, digest-pinned
references, untagged references, and `latest` are not valid build destinations.
The command requires Docker Buildx but does not start or contact the DIM
controller. Workspace creation never builds an image implicitly.

The repository also contains host-backend installers. Read
the [setup guide](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/usage.md)
before using the CLI on a new host. Docker's ordinary runc runtime remains an
internal dependency for trusted infrastructure; it is not a selectable
workspace isolation boundary.

## Installation

Install an exact, reviewed version globally:

```bash
npm install --global "@slop-lab/dim-cli@0.9.0"
```

Or use the user-local installer:

```bash
npx '@slop-lab/dim-installer@0.9.0' install-cli
export PATH="$HOME/.local/bin:$PATH"
```

See the [installer README](https://www.npmjs.com/package/@slop-lab/dim-installer)
for mise-based and direct-`PATH` alternatives.

Do not track `latest`. DIM controls container runtimes and executes code from
Project repositories, so follow the mandatory
[adoption and trust requirements](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/adoption.md).

Check the host before creating a workspace:

```bash
dim doctor
```

DIM automatically runs one managed controller process with separate local
Unix sockets: a mode-`0600` host-admin API and a workspace-scoped API. Normal
state commands are admin API clients. Workspace, CI runner, and host lifecycle
operations, CI logs, `exec`, and `run` use host-admin controller command
sessions. Sessions preserve ordered stdout and stderr streams plus FIFO input
and EOF. They allocate a PTY only when `exec` or `run` is attached to an
interactive terminal. Controller bootstrap and local Git process adapters stay
local. Neither the admin socket nor host credentials are mounted into
workspaces.

After claiming the managed controller PID and before loading plugins or opening
listeners, startup performs the one supported pre-stable state migration: a
strict host-only `host.json` schema 1 record becomes schema 2 by renaming
`resumeCiRunners` to `restartCiRunners`. The original bytes remain permanently
in mode-`0600` `host.json.schema-1.bak`. Startup reports only a completed
migration or backup recovery; an unsafe, malformed, or conflicting artifact is
reported as a host-lifecycle-migration startup-stage failure. All other state
schemas remain rejection-only.

## First Project

Create a Project from a repository whose `.dim/repos.yml` declares its stable
root alias and policy:

```bash
dim project create acme \
  --bootstrap-git-url /path/to/acme \
  --bootstrap-git-ref main --apply-repos
```

`repo add` runs source clone through the invoking host Git CLI, so existing
credential helpers, SSH configuration, and SSH agent work for any Git URL.
The manifest alias is explicit and scoped to the Project.
If the source is temporarily unavailable, fix host connectivity or
credentials and repeat the same `project create` command; DIM resumes only a
failed root import with the same manifest-derived root alias and origin.

```bash
dim repo add acme root https://example.com/acme.git --root --ref main
```

For a manifest-free repository, provide the root alias and policy explicitly:

```bash
dim project create acme \
  --root root --bootstrap-git-url https://example.com/acme.git \
  --bootstrap-git-ref main --protect main
```

With manifest bootstrap, DIM automatically applies additional repositories
that all use the bootstrap origin. A manifest containing another origin still
requires interactive confirmation or `--apply-repos`; `--no-apply-repos`
always skips explicitly.

Managed-root manifests are read without a checkout, so use network/scp-style
Git URLs or absolute paths in tracked `.dim/repos.yml`; relative filesystem
paths are rejected. A local file passed with `--repos` or `repo apply --file`
is never copied into or written over the tracked root manifest.

Declining or using `--no-apply-repos` does not require another clone. Run
`dim repo plan acme` and `dim repo apply acme --yes` to read the file from the
managed root. `project create --repos FILE` is reserved for a standalone local
bootstrap manifest.

An existing root origin remains a conflict during ordinary apply. To replace
only that recorded URL during a reviewed maintenance window, first quiesce
Project writers and stop its workspaces and CI runners. Review the candidate
manifest, verify the new HTTPS origin's protected branch tip independently,
and then supply the exact full lowercase commit ID:

```bash
dim repo apply acme --file candidate/.dim/repos.yml \
  --rebind-origin root \
  --expect-origin-tip 0123456789abcdef0123456789abcdef01234567 \
  --yes
```

All three rebind options are required together. DIM accepts only an existing,
ready, protection-applied Project root whose alias, concrete root ref, ref
mapping, publish mapping, and protection policy exactly match the reviewed
manifest. The new URL must be credential-free HTTPS, must still advertise the
expected commit when the locked update completes, and the current managed root
tip must be an ancestor of that commit. DIM also rejects the update if the
managed tip or recorded old URL changes during verification.

This operation changes no managed Git ref, branch protection, repository
identity, omitted repository record, or workspace record. In particular,
aliases omitted from the candidate manifest are reported as `preserve` and
remain registered. Existing workspaces remain pinned to their previous root
snapshot; for a conversion
where they need not remain restartable, discard and recreate them after
inspecting `dim repo show acme root` and a fresh `dim repo plan acme --file
candidate/.dim/repos.yml`. Do not restart old workspaces as part of the
conversion.

## External workspace URLs

The optional external URL system plugin exposes named ingresses. Configure a
local ingress and operate it from the host without project-specific curl
tasks:

```bash
dim external-url ingress add http --name local-http \
  --description "Local development URL" \
  --scheme http \
  --domain dev.test --public-port 8080 \
  --listen-host 0.0.0.0 --listen-port auto

dim external-url discover
dim external-url request --ingress local-http --container dev --port 3000
dim external-url list
```

These commands normally run with the current workspace's controller socket
and grant. `--workspace work-1` is available for host-side administration.

Cloudflare DNS and Caddy HTTPS setup are documented in the
[External URLs guide](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/external-urls.md).

Create and enter a persistent workspace:

```bash
dim workspace create acme feature-123 --profile development
dim workspace create acme feature-123 --recommend-capability writable-cgroup
dim workspace exec feature-123 -- bash
```

Run a task through the root repository's `.dim/entrypoint.sh`:

```bash
dim workspace run feature-123 bash
```

The controller command session forwards task stdin even when redirected or
piped, so Project-defined streaming tasks can use contracts such as `dim
workspace run feature-123 restore <backup.tar.gz`. Input bytes and EOF remain
ordered, and a TTY is allocated only for an interactive terminal.

`exec` is the raw escape hatch; `run` uses the Project-defined task contract.

## Everyday lifecycle

```bash
dim workspace list
dim workspace show feature-123
dim workspace resources feature-123 --cpus 4 --memory 8g --pids 4096
dim workspace stop feature-123
dim workspace start feature-123
dim workspace restart feature-123 review-456
dim workspace update feature-123
dim workspace setup feature-123
dim workspace discard feature-123 --keep-volume --yes
```

- `stop` preserves the checkout and nested container-engine storage.
- `resources` changes any supplied live or stopped workspace limits and keeps
  omitted limits unchanged.
- `start` refreshes the root ref and runs setup.
- `restart` is the explicit way to apply merged root-repository changes to one
  or more workspaces. Multiple names are processed in command-line order; a
  failure stops before later names while keeping earlier restarts complete.
- `update` reuses the running outer container when the selected root is
  unchanged. A changed root replaces that container before setup and may
  interrupt outer processes and nested runtimes while preserving named
  persistent data.
- `setup` retries setup without changing the root ref.
- `discard` permanently removes the workspace and unpushed changes; use
  `--keep-volume` to retain DIM-managed nested-engine data for recreation with
  the same workspace name.

If a controller command session for `create`, `setup`, `update`, `start`, or
`restart` fails, the CLI preserves the failure context and recommends running
`dim doctor` to check host readiness. `dim doctor` is diagnostic only; it does
not repair workspace lifecycle state or retry the failed command.

DIM only performs fast-forward root updates. It will not overwrite divergent
workspace history.

## Multiple repositories

Register additional repositories under stable aliases:

```bash
dim repo add acme product
dim repo add acme secrets-code https://example.com/secrets-code.git
dim repo list acme
```

The root lifecycle receives a Project-specific base URL such as
`http://dim-gitea:3000/dim-acme` in `DIM_GIT_BASE_URL`, plus a small runtime
manifest at `DIM_PROJECT_MANIFEST`. The manifest identifies the immutable root,
persistent workspace-data path, and generic runtime capabilities. Project code
owns repository aliases, refs, checkout paths, and services. DIM neither
exports a variable per repository nor assumes a repository-to-container mapping. Projects can independently map
different upstream repository names without making their normal configuration
depend on DIM.

### Synchronizing an external repository

For a repository registered with an external URL, fetch remote branches into
managed Gitea under `upstream/*` and import tags:

```bash
dim repo fetch acme product
dim repo fetch acme product --prune
```

This preserves DIM-only branches. Configure reviewed publish mappings in
`.dim/repos.yml`, then publish one repository or every configured repository:

```bash
dim repo publish acme product
dim repo publish acme
```

HTTP authentication is resolved from the invoking host's Git credential helper
and forwarded only for the request. SSH authentication and local paths belong
to the configured service account on the Git host. Publishing is non-forced.

Deploy the narrow service beside Gitea repository storage before using these
commands:

```bash
dim repo sync-service image build registry.example/dim-git-sync:0.9.0
export DIM_GIT_SYNC_CONNECTION_FILE="$HOME/.config/dim/git-sync.json"
```

The service keeps a credential-free `dim-upstream` remote in the actual bare
repository and resolves aliases through its private registry. It is an
optional explicit capability: commands fail closed when it is absent, with no
temporary-clone fallback. The shared Git-host synchronization example contains
complete service and host files.

Use independent `import` and `publish` mappings when a managed repository's
branch name differs from its external archive branch:

```yaml
repositories:
  core:
    url: https://github.com/example/archive.git
    import: {main: dev/core}
    publish: {main: main}
```

The import creates only managed `main` from external `dev/core`; it does not
copy unrelated archive branches or tags. The publish destination is
connection-relative `main`, which maps back to external `dev/core`, and
separately authorizes that reverse update.

To keep DIM repositories separate while synchronizing them with one external
Git repository, declare a shared upstream in `.dim/repos.yml`:

```yaml
schemaVersion: 1
upstreams:
  product:
    url: https://github.com/example/product.git
repositories:
  root: {upstream: product, fallback: true, root: true, ref: main}
  api: {upstream: product, refPrefix: api/}
```

Managed `api` ref `refs/heads/main` maps to external
`refs/heads/api/main`; root refs that do not match `api/` keep their names.
Branches and tags use the same mapping, and commit IDs are preserved. Prefixes
must end in `/` and cannot overlap. A shared upstream has at most one explicit
fallback; without one, unmatched refs are ignored. Repositories using `url`
continue to synchronize with separate external repositories.

Delete an unused non-root repository with:

```bash
dim repo delete acme obsolete --yes
```

## Project CI runners

Each named Project-scoped runner can serve every repository in the Project's
managed Git organization. Enable multiple runners, including multiple runners
of the same executor kind, when the Project needs parallel capacity:

```bash
dim ci runner create acme primary sysbox
dim ci runner create acme release qemu
dim ci runner status acme primary
dim ci runner logs acme primary
dim ci runner logs acme release
```

Ordinary jobs use a Sysbox container and nested Docker daemon outside
development workspaces, with independent cgroup limits. Built-in defaults are
4 CPUs, 8 GiB memory, and 2,048 PIDs. Change the user-level fallback or
override one runner:

```bash
dim ci runner defaults set --cpus 2 --memory 4g --pids 1024
dim ci runner create acme primary sysbox --cpus 6 --memory 12g --pids 4096
dim ci runner create acme release qemu --cpus 6 --memory 12g
```

QEMU maps CPU and memory overrides to guest vCPUs and RAM. `--pids`
applies only to Sysbox runners.

QEMU scheduling remains host-local unless
`DIM_QEMU_SCHEDULER_CONNECTION_FILE` selects an operator-managed shared
scheduler. To share queued demand across hosts using external Gitea, build the
standalone image from this exact CLI release and deploy it with a durable
volume and a service-user-owned mode-`0600` config:

```bash
dim ci scheduler image build registry.example/dim-qemu-scheduler:0.9.0
```

Each DIM host uses a distinct stable host ID that must equal that host's
external Gitea connection `hostId`. All hosts attached to one Project use the
same Project API bearer token; the host ID is concurrency identity, not
authorization or a separate credential. The central service has a distinct
Gitea webhook token and no Gitea administrator credential. Use HTTPS, loopback
HTTP, or an explicitly isolated HTTP network. See the shared QEMU scheduler
example in the DIM examples repository for complete service and host files.

Configure a 60-second-or-longer lease and explicitly allow the Project's QEMU
integration labels in the service config. DIM renews every five seconds with
two-second requests; the service retains expired ownership for a 20-second
cleanup grace and holds outstanding queued claims across restart. This bounds
normal failover but cannot fence a paused, partitioned, or compromised host at
the infrastructure layer.

The service admits at most 10,000 queued or running jobs and 100,000 claim
request receipts per Project. New demand or claims receive HTTP `503` at
saturation; existing jobs, claims, and live fences are not evicted. Restored
terminal webhook delivery frees nonterminal capacity. Released claim receipts
expire after seven days, while a receipt that still protects a live claim is
retained until that claim is gone. Unsuccessful supervisors release only after
termination and reaping, then retry with shutdown-interruptible exponential
backoff capped at 30 seconds.

On nested-KVM-capable hosts, enabling `qemu` starts a small trusted webhook
supervisor that boots a fresh ephemeral VM only for a queued `dim-qemu` job.
Workflow code sees only nested KVM inside that VM. Use `list`, `start`,
`restart`, `stop`, and `delete --yes` with the Project and runner name. The lifecycle boundary
is provider-neutral; managed Gitea is the current coordinator.

`logs` follows the container log through a controller command session until
interrupted. `stop` preserves the runner registration and local data; `delete
--yes` removes both.

## Managed Git credentials

`dim x git` is a one-shot wrapper around the ordinary Git CLI. It adds a
temporary credential helper for DIM's managed Gitea and forwards every
remaining argument unchanged:

```bash
dim x git clone "$(dim repo url acme product)"
dim x git -C product push origin HEAD
```

Plain `git` remains available for external URLs and locally configured
credentials. To make ordinary host-side Git commands use DIM credentials
without the wrapper, install a URL-scoped credential helper:

```bash
dim git setup
git clone "$(dim repo url acme product)"
```

The helper is scoped to DIM's managed HTTP endpoint and enables path-aware
matching. That lets a future gateway select credentials from the requested
Project path without changing each repository's Git configuration.

## Project cleanup

```bash
dim project remove acme
dim project purge acme --yes
```

`remove` deletes only DIM's Project metadata and preserves managed Git data.
`purge` deletes the unused Project's managed repositories and Gitea
organization as well. Both reject Projects still referenced by workspaces.
With external Gitea, `remove` remains the local detach operation. Host-admin
`purge` and `repo delete` requests delete the shared remote resources after the
ordinary checks. Other hosts' independent local records are not removed, but
their access to the deleted repository or Project is intentionally broken.

## CLI discovery and automation

```bash
dim --help
dim project --help
dim repo --help
dim workspace image build --help
dim help --all
dim project show --json acme
```

Normal list commands use compact tables. Record-producing subcommands expose
their own `--json` option; commands where JSON has no useful meaning do not.
URL commands deliberately emit a bare URL.

State is stored under `~/.local/state/dim` by default. The most useful
overrides are:

- `DIM_STATE_ROOT`
- `DIM_GITEA_PORT` (default `3300`)
- `DIM_GITEA_CONNECTION_FILE` (explicit external Gitea connection and shared
  Project bindings)
- `DIM_GIT_SYNC_CONNECTION_FILE` (explicit physical-Git-host sync service)
- installed `workspaceBackend` from the DIM user configuration
- `DIM_WORKSPACE_IMAGE`
- `DIM_WORKSPACE_CPUS`, `DIM_WORKSPACE_MEMORY`, and `DIM_WORKSPACE_PIDS`

The resource environment variables are defaults. Set persistent limits for an
individual workspace at creation time or change them later:

```bash
dim workspace create acme feature-123 --cpus 4 --memory 8g --pids 4096
dim workspace resources feature-123 --memory 12g
```

DIM is pre-stable and rejects incompatible state between `0.x` releases except
for the explicitly documented host lifecycle schema 1-to-2 migration. Push all
important work before upgrading and review the release notes.

For the complete lifecycle and `.dim` hook contracts, see
[Repository-backed Workspaces](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/repo-workspaces.md)
and
[Project Workspaces](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/project-workspaces.md).
Source and issues are in the
[project repository](https://github.com/slop-lab/dev-infra-manager).
