# @slop-lab/dim-cli

`dim` creates persistent, isolated development workspaces around a
review-controlled Git repository. It is intended for AI-assisted development
where agent changes must be pushed and reviewed before they reach protected
branches or secret-bearing environments.

## How DIM models a project

A DIM **Project** is lightweight metadata:

- a name and a dedicated `dim-<project>` namespace in DIM's managed Gitea;
- one required **root repository** and its branch ref;
- any additional repositories that belong to the Project.

Each **workspace** clones only the root repository. The root repository's
optional `.dim/setup.sh`, `.dim/entrypoint.sh`, and Compose configuration can
clone or start the other repositories. DIM therefore tracks one root ref
instead of trying to prescribe a multi-repository checkout layout.

A running workspace is never changed automatically when the Project changes.
`dim start`, `dim restart`, and `dim update` fast-forward the configured root
ref and run setup. This keeps an active agent session stable while making
refreshes explicit.

## Requirements

- Linux with Node.js 22 or newer.
- Git and a working Docker CLI/daemon.
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
npm install --global "@slop-lab/dim-cli@0.2.0"
```

Or use the user-local installer:

```bash
npx "@slop-lab/install-dim@0.2.0" cli
export PATH="$HOME/.local/bin:$PATH"
```

Do not track `latest`. DIM controls container runtimes and executes code from
Project repositories, so follow the mandatory
[adoption and trust requirements](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/adoption.md).

Check the host before creating a workspace:

```bash
dim doctor --backend sysbox
```

## First Project

Create a Project and an empty root repository:

```bash
dim project create acme
dim repo create acme root --root --ref main
```

Push an existing local repository with ordinary Git. `url-for-host` prints
only the clone URL, so it is safe to use in command substitution:

```bash
git -C /path/to/acme push "$(dim repo url-for-host acme root)" main
dim repo protect acme root
```

Protection is a separate step because an empty Git repository cannot protect a
branch before its first push.

Alternatively, create and mirror a managed repository in one command:

```bash
dim repo import acme root https://example.com/acme.git --root --ref main
```

Import uses the host's local `git` executable and its existing authentication.
DIM does not define a general Git-provider abstraction.

Create and enter a persistent workspace:

```bash
dim create acme feature-123 --backend sysbox --profile development
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
dim stop feature-123
dim start feature-123
dim restart feature-123
dim update feature-123
dim setup feature-123
dim discard feature-123 --yes
```

- `stop` preserves the checkout and nested container-engine storage.
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
dim repo create acme product
dim repo import acme secrets-code https://example.com/secrets-code.git
dim repo list acme
```

The root lifecycle receives repository locations as normalized environment
variables such as `DIM_REPO_PRODUCT` and `DIM_REPO_SECRETS_CODE`, plus a
Project manifest at `DIM_PROJECT_MANIFEST`. The root repository decides where
and how to clone them; DIM does not require every Project to use the same
directory names.

## Managed Git credentials

For managed Gitea operations, use either the workspace's configured
credential helper/askpass environment or the host-side wrapper:

```bash
dim x git clone "$(dim repo url-for-host acme product)"
dim x git -C product push origin HEAD
```

Plain `git` remains available for external URLs and locally configured
credentials.

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
dim --json project show acme
```

Normal list commands use compact tables. `--json` provides machine-readable
records. URL commands deliberately emit a bare URL even in normal use.

State is stored under `~/.local/state/dim` by default. The most useful
overrides are:

- `DIM_STATE_ROOT`
- `DIM_GITEA_PORT` (default `3300`)
- `DIM_WORKSPACE_BACKEND`
- `DIM_WORKSPACE_IMAGE`
- `DIM_WORKSPACE_CPUS`, `DIM_WORKSPACE_MEMORY`, and `DIM_WORKSPACE_PIDS`

Version 0.2.0 is a breaking state schema. It rejects 0.1 Project/workspace
state and does not migrate it.

For the complete lifecycle and `.dim` hook contracts, see
[Repository-backed Workspaces](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/repo-workspaces.md)
and
[Project Workspaces](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/project-workspaces.md).
Source and issues are in the
[project repository](https://github.com/slop-lab/dev-infra-manager).
