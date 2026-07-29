# CLI Contract

## Common behavior

- The package exposes `dim`.
- `--help` is hierarchical; `dim help --all` also shows administrative commands.
- User errors and invalid CLI input exit with code `2`; unexpected errors exit
  with code `1`.
- Record commands print a human-readable summary by default. Record-producing
  subcommands expose their own `--json`; non-record commands do not.
- URL commands print exactly one URL on stdout.
- DIM 0.2 rejects 0.1 project/workspace state and does not migrate it.

## Projects

```bash
dim project create PROJECT
dim project list
dim project show PROJECT
dim project remove PROJECT
dim project purge PROJECT --yes
```

`create` atomically claims Project metadata and reconciles the reserved
`dim-PROJECT` organization in the managed Gitea service. A Project may be
assembled without a root, but it is not runnable until it has exactly one root
repository. Its ref is optional and falls back to the repository's symbolic
`HEAD`; a missing configured ref and missing `HEAD` is an error.

`remove` removes only DIM Project metadata. It preserves the managed Git
organization and repositories and refuses while a workspace references the
Project. `purge` has the same reference check and permanently deletes the
DIM-managed Git organization and repositories after explicit confirmation.

## Repositories

```bash
dim repo create PROJECT ALIAS [--root] [--ref BRANCH] [--protect PATTERNS]
dim repo import PROJECT ALIAS SOURCE [--root] [--ref BRANCH] [--protect PATTERNS]
dim repo protect PROJECT ALIAS
dim repo list PROJECT
dim repo show PROJECT ALIAS
dim repo url PROJECT ALIAS
dim repo url --workspace PROJECT ALIAS
```

Every repository belongs to one Project namespace. `create` makes an empty
repository and leaves configured protection pending so an initial standard Git
push can populate it. `protect` applies protection after that push. Workspace
creation also applies pending protection to the root repository.
No protection pattern is implied. Projects pass their actual policy through
`--protect`; an omitted option records no patterns.
For a root with no configured ref, `protect` sets Gitea `HEAD` when exactly one
branch exists and does not guess when multiple branches exist.

`import` is a convenience wrapper over `git clone --mirror`, repository
creation, `git push --mirror`, and protection. Existing local Git
authentication is used for the source URL.

Host and workspace URLs never contain credentials.

## Workspaces

```bash
dim create PROJECT WORKSPACE \
  [--profile PROFILE ...] \
  [--kvm] \
  [--cpus COUNT] [--memory SIZE] [--pids-limit COUNT]

dim ls
dim show WORKSPACE
dim exec WORKSPACE -- COMMAND [ARGS...]
dim run WORKSPACE TASK [ARGS...]
dim setup WORKSPACE
dim update WORKSPACE [--profile PROFILE ... | --clear-profiles]
dim start WORKSPACE
dim restart WORKSPACE
dim stop WORKSPACE
dim discard WORKSPACE --yes
```

`create` clones the Project root repository/ref at `/workspace/project` and
runs its `.dim` setup contract. DIM directly manages no other checkout; the
root repository lifecycle owns additional clones and nested services.
Resource flags are stored in the workspace record. Environment configuration
provides their defaults but does not force one limit set on every workspace.
`--kvm` stores an immutable workspace capability and passes the host
`/dev/kvm` device directly into the trusted workspace container.
The runtime backend defaults to the backend recorded during installation.
Omitting `--profile` stores an empty profile list and starts ordinary
non-profiled Compose services.

Running workspaces do not change when Project metadata or the root remote
changes. `start` applies the configured root ref to a stopped workspace before
setup. `restart` stops a running workspace and performs the same start,
fast-forward, and setup sequence. Dirty root checkouts and non-fast-forward
updates are rejected without reset.

`run` dispatches through `.dim/entrypoint.sh` when present. `exec` always
bypasses it. `discard` requires `--yes`, attempts project teardown, and removes
the top-level container, inner-engine volume, and workspace state.

## External URL commands

Host configuration is managed through:

```text
dim external-url add-provider cloudflare NAME [OPTIONS]
dim external-url list-providers [--json]
dim external-url remove-provider NAME
dim external-url add-ingress NAME [OPTIONS]
dim external-url list-ingresses [--json]
dim external-url setup-ingress NAME [--output DIRECTORY]
dim external-url verify-ingress NAME
dim external-url remove-ingress NAME [--cleanup-dns]
```

Workspace-scoped URL operations are:

```text
dim external-url discover [--workspace WORKSPACE] [--json]
dim external-url create [--workspace WORKSPACE] --ingress NAME
  --service SERVICE [--container NAME ...] --port PORT [--protocol http|https]
dim external-url list [--workspace WORKSPACE] [--json]
dim external-url remove URL_ID [--workspace WORKSPACE]
dim host-input get PROVIDER KEY [--parameters STRING]
```

Inside a workspace the controller endpoint and grant come from
`DIM_CONTROLLER_SOCKET` and `DIM_CONTROLLER_TOKEN`. On the host, `--workspace`
loads that workspace's stored grant and uses DIM's managed controller socket.

## Git integration

```bash
dim x git ARGS...
dim git setup
```

Runs the local Git CLI with managed Gitea credentials supplied through
environment and a one-command credential helper. It does not put credentials
in argv or repository URLs. Existing Git credential helpers and SSH agents
remain valid alternatives.

`git setup` installs a URL-scoped, path-aware global Git credential helper for
ordinary host-side Git commands. The requested URL path remains available for
future Project-aware gateway routing.

## Diagnostics and administration

```bash
dim doctor
dim plugin list
dim admin service ensure
dim admin service credentials --show-secrets
```

Administrative commands are omitted from the default root help.
