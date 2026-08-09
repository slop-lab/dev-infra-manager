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
`dim start`, `dim restart`, and `dim update` fast-forward the configured root
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
npm install --global "@slop-lab/dim-cli@0.5.0"
```

Or use the user-local installer:

```bash
npx '@slop-lab/dim-installer@0.5.0' install-cli
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

Create a Project and import its root repository:

```bash
dim project create acme \
  --root root --url /path/to/acme \
  --ref main --protect main,development
```

`repo add` runs source clone through the invoking host Git CLI, so existing
credential helpers, SSH configuration, and SSH agent work for any Git URL.
The alias is explicit and scoped to the Project.

```bash
dim repo add acme root https://example.com/acme.git --root --ref main
```

When the imported root contains `.dim/repos.yml`, an interactive invocation
offers to apply it. Choose explicitly for scripts:

```bash
dim project create acme \
  --root root --url https://example.com/acme.git \
  --ref main --apply-repos
```

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
  --argument '{"domain":"dev.test","publicPort":8080,"listenHost":"0.0.0.0","listenPort":"auto"}'

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
dim create acme feature-123 --profile development
dim exec feature-123 -- bash
```

Run a task through the root repository's `.dim/entrypoint.sh`:

```bash
dim run feature-123 codex
```

`exec` is the raw escape hatch; `run` uses the Project-defined task contract.

## Everyday lifecycle

```bash
dim ls
dim show feature-123
dim resources feature-123 --cpus 4 --memory 8g --pids-limit 4096
dim stop feature-123
dim start feature-123
dim restart feature-123
dim update feature-123
dim setup feature-123
dim discard feature-123 --yes
```

- `stop` preserves the checkout and nested container-engine storage.
- `resources` changes any supplied live or stopped workspace limits and keeps
  omitted limits unchanged.
- `start` refreshes the root ref and runs setup.
- `restart` is the explicit way to apply merged root-repository changes to a
  running workspace.
- `update` fast-forwards the root ref without a stop/start cycle.
- `setup` retries setup without changing the root ref.
- `discard` permanently removes the workspace and unpushed changes.

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
manifest at `DIM_PROJECT_MANIFEST`. Project code constructs managed URLs such
as `$DIM_GIT_BASE_URL/product.git` and decides which repositories, checkout
names, and services it supports. DIM neither exports a variable per repository
nor assumes a repository-to-container mapping. Projects can independently map
different upstream repository names without making their normal configuration
depend on DIM.

### Synchronizing an external repository

For a repository registered with an external URL, fetch remote branches into
managed Gitea under `upstream/*` and import tags:

```bash
dim repo fetch acme product
dim repo fetch acme product --prune
```

This preserves DIM-only branches. Non-fast-forward upstream changes are
rejected. Push back only explicitly named branch or tag refspecs:

```bash
dim repo push acme product \
  refs/heads/main:refs/heads/main \
  refs/tags/v1.2.3:refs/tags/v1.2.3
```

External authentication comes from the invoking host Git process. Pushes are
non-forced.

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

## Project CI runner

One isolated, Project-scoped runner can serve every repository in a Project's
managed Git organization:

```bash
dim ci runner enable acme
dim ci runner status acme
dim ci runner logs acme
```

The runner uses its own Sysbox container and nested Docker daemon outside
development workspaces, with independent cgroup limits. Built-in defaults are
4 CPUs, 8 GiB memory, and 2,048 PIDs. Change the user-level fallback or
override one runner:

```bash
dim ci runner defaults set --cpus 2 --memory 4g --pids-limit 1024
dim ci runner enable acme --cpus 6 --memory 12g --pids-limit 4096
```

Use `list`, `restart`, `stop`, and `disable --yes` for lifecycle management.
The core lifecycle boundary is provider-neutral, but 0.5.0 ships only the
managed-Gitea coordinator and Sysbox container executor. QEMU is not yet a
selectable CI runner backend.

`logs` follows the container log until interrupted. `stop` preserves the
runner registration and local data; `disable --yes` removes both.

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
dim create acme feature-123 --cpus 4 --memory 8g --pids-limit 4096
dim resources feature-123 --memory 12g
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
