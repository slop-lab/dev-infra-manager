# CLI Contract

## Common behavior

- The package exposes `dim`.
- `--help` is hierarchical; `dim help --all` also shows administrative commands.
- User errors and invalid CLI input exit with code `2`; unexpected errors exit
  with code `1`.
- Record commands print a human-readable summary by default. Record-producing
  subcommands expose their own `--json`; non-record commands do not.
- URL commands print exactly one URL on stdout.
- DIM rejects incompatible pre-stable project/workspace state and does not
  migrate it implicitly.
- Except for interactive `exec` and `run`, commands that inspect or mutate DIM
  state are clients of the managed host-admin controller API. `exec` and `run`
  remain direct CLI adapters until the controller has a streaming terminal
  protocol. Local process adapters such as `x git`, the Git credential helper,
  and controller bootstrap may execute locally, but obtain DIM-owned state and
  credentials through the admin API.
- The managed controller uses separate Unix sockets. The host-admin socket is
  mode `0600` and is never mounted into a workspace. The workspace socket
  accepts workspace-scoped grants and is mounted only into the trusted
  workspace root.

## Projects

```bash
dim project create PROJECT [--repos FILE] [--yes]
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
dim repo add PROJECT ALIAS [URL] [--root] [--ref BRANCH] [--protect PATTERNS]
dim repo plan PROJECT [--file FILE]
dim repo apply PROJECT [--file FILE] [--yes]
dim repo protect PROJECT ALIAS
dim repo list PROJECT
dim repo show PROJECT ALIAS
dim repo url PROJECT ALIAS
dim repo url --workspace PROJECT ALIAS
```

Every repository alias belongs to one Project namespace and is always
supplied explicitly; DIM never derives it from a URL. `add` without a URL
creates an empty repository and leaves protection pending. `add` with a URL
uses the invoking CLI's host `git` process to mirror the source into managed
Gitea, then applies protection. Workspace creation also applies pending
protection to the root repository.
No protection pattern is implied. Projects pass their actual policy through
`--protect`; an omitted option records no patterns.
For a root with no configured ref, `protect` sets Gitea `HEAD` when exactly one
branch exists and does not guess when multiple branches exist.

`repos.yml` contains `schemaVersion: 1` and a `repositories` object whose
property names are Project-scoped aliases. Each value may contain `url`,
`root`, `ref`, and `protect`. `project create --repos` requires exactly one
`root: true`. `repo apply` updates an existing Project without deleting
repositories omitted from the file. Reapplying an identical entry is a no-op;
an existing alias with a different URL, root role/ref, or protection policy is
a conflict rather than an implicit mutation. With no `--file`, it reads the
managed root's optional `.dim/repos.yml`.

The CLI asks before applying a discovered root file in a TTY. Non-interactive
use requires `--yes` or `--apply-repos`; it never answers its own prompt.
Repository-set planning and all state transitions use the admin API. External
clone/push transport is a local CLI adapter so current host credential helpers,
SSH configuration, and SSH agent are used. The managed Gitea credential is
applied only to the destination push.

The built-in admin operations are:

```text
repo.plan       validate and compare a canonical RepositorySet
repo.prepare    claim an alias, create its Gitea target, and begin a transfer
repo.complete   finish or fail the identified transfer and update state
repo.root-set   read and parse .dim/repos.yml from the managed root ref
```

`repo.prepare` returns an opaque transfer ID and destination-only Gitea
credential to the host CLI. `repo.complete` accepts only the active transfer
ID for that Project/alias. API inputs use normalized JSON field names
`rootRef` and `protectedPatterns`; YAML `ref` and `protect` are file-format
adapters, not API fields.

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
dim external-url ingress add DRIVER --name NAME --description TEXT
  --scheme SCHEME --argument STRING
dim external-url ingress list [--json]
dim external-url ingress setup NAME [--output DIRECTORY]
dim external-url ingress verify NAME
dim external-url ingress remove NAME [--cleanup-dns]
```

Workspace-scoped URL operations are:

```text
dim external-url discover [--workspace WORKSPACE] [--json]
dim external-url request [--workspace WORKSPACE] --ingress NAME
  [--name NAME] [--container NAME ...] --port PORT [--protocol http|https]
dim external-url list [--workspace WORKSPACE] [--json]
dim external-url revoke URL_ID [--workspace WORKSPACE]
dim host-input get PROVIDER KEY [--parameters STRING]
```

The ingress `argument` is an opaque string interpreted only by its driver.
Drivers return public URLs rather than asking the common controller to derive
domains. A missing request name receives the first unused numeric name, and
the public DNS label begins `WORKSPACE--NAME`. Workspace discard revokes all
routes authenticated by that workspace grant before removing the grant.

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
