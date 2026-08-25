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

Each **workspace** clones only the root repository. The root repository's
optional `.dim/setup.sh`, `.dim/entrypoint.sh`, and Docker Compose
configuration own any additional checkouts and nested containers. A repository
does not need to correspond one-to-one with a container. DIM therefore tracks
one root ref instead of prescribing a multi-repository runtime layout. When no
root ref is configured, DIM resolves the repository's symbolic `HEAD`;
workspace creation fails if the repository has no `HEAD`.

A running workspace is never changed automatically when the Project changes.
`dim workspace start`, `dim workspace restart`, and `dim workspace update` fast-forward the configured root
ref and run setup. This keeps an active agent session stable while making
refreshes explicit.

## Requirements

- A Linux host with a systemd user manager. macOS, Windows, and Docker Desktop
  hosts are not supported.
- Node.js 24 or 26.
- Git and a working Docker CLI/daemon. DIM always uses Docker to manage the
  outer workspace container, regardless of the selected backend.
- A supported workspace backend: Sysbox, gVisor, rootless Podman, or
  privileged runc.
- The DIM workspace image appropriate for that backend.

The repository contains host-backend installers and image build recipes. Read
the [setup guide](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/usage.md)
before using the CLI on a new host. Privileged runc is provided for
compatibility and CI smoke testing; it is not the preferred isolation boundary.

## Installation

Install an exact, reviewed version globally:

```bash
npm install --global "@slop-lab/dim-cli@0.8.0"
```

Or use the user-local installer:

```bash
npx '@slop-lab/dim-installer@0.8.0' install-cli
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
state commands are admin API clients. Only interactive `exec` and `run` remain
direct CLI operations; controller bootstrap and local Git process adapters
also stay local. Neither the admin socket nor host credentials are mounted
into workspaces.

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
dim workspace run feature-123 codex
```

Task stdin is forwarded even when redirected or piped, so Project-defined
streaming tasks can use contracts such as `dim workspace run feature-123
restore <backup.tar.gz`. A TTY is allocated only for an interactive terminal.

`exec` is the raw escape hatch; `run` uses the Project-defined task contract.

## Everyday lifecycle

```bash
dim workspace list
dim workspace show feature-123
dim workspace resources feature-123 --cpus 4 --memory 8g --processes 4096
dim workspace stop feature-123
dim workspace start feature-123
dim workspace restart feature-123
dim workspace update feature-123
dim workspace setup feature-123
dim workspace discard feature-123 --keep-volume --yes
```

- `stop` preserves the checkout and nested container-engine storage.
- `resources` changes any supplied live or stopped workspace limits and keeps
  omitted limits unchanged.
- `start` refreshes the root ref and runs setup.
- `restart` is the explicit way to apply merged root-repository changes to a
  running workspace.
- `update` fast-forwards the root ref without a stop/start cycle.
- `setup` retries setup without changing the root ref.
- `discard` permanently removes the workspace and unpushed changes; use
  `--keep-volume` to retain DIM-managed nested-engine data for recreation with
  the same workspace name.

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
manifest at `DIM_PROJECT_MANIFEST`. Each ready repository record includes its
requested ref, resolved ref, and exact commit SHA. Project code decides checkout
paths and services but materializes that recorded commit. DIM neither exports a variable per repository
nor assumes a repository-to-container mapping. Projects can independently map
different upstream repository names without making their normal configuration
depend on DIM.

Use a non-root candidate ref without changing Project state when creating a
verification workspace:

```bash
dim workspace create acme candidate --repo-ref product=refs/pull/42/head
```

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

External authentication comes from the invoking host Git process. Publishing
is non-forced.

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
dim ci runner defaults set --cpus 2 --memory 4g --processes 1024
dim ci runner create acme primary sysbox --cpus 6 --memory 12g --processes 4096
dim ci runner create acme release qemu --cpus 6 --memory 12g
```

QEMU maps CPU and memory overrides to guest vCPUs and RAM. `--processes`
applies only to Sysbox runners.

On nested-KVM-capable hosts, enabling `qemu` starts a small trusted webhook
supervisor that boots a fresh ephemeral VM only for a queued `dim-qemu` job.
Workflow code sees only nested KVM inside that VM. Use `list`, `start`,
`restart`, `stop`, and `delete --yes` with the Project and runner name. The lifecycle boundary
is provider-neutral; managed Gitea is the current coordinator.

`logs` follows the container log until interrupted. `stop` preserves the
runner registration and local data; `delete --yes` removes both.

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

## CLI discovery and automation

```bash
dim --help
dim project --help
dim repo --help
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
- installed `workspaceBackend` from the DIM user configuration
- `DIM_WORKSPACE_IMAGE`
- `DIM_WORKSPACE_CPUS`, `DIM_WORKSPACE_MEMORY`, and `DIM_WORKSPACE_PIDS`

The resource environment variables are defaults. Set persistent limits for an
individual workspace at creation time or change them later:

```bash
dim workspace create acme feature-123 --cpus 4 --memory 8g --processes 4096
dim workspace resources feature-123 --memory 12g
```

DIM is pre-stable and does not migrate incompatible state between `0.x`
releases. Push all important work before upgrading and review the release
notes.

For the complete lifecycle and `.dim` hook contracts, see
[Repository-backed Workspaces](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/repo-workspaces.md)
and
[Project Workspaces](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/project-workspaces.md).
Source and issues are in the
[project repository](https://github.com/slop-lab/dev-infra-manager).
