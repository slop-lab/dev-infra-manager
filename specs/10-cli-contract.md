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
dim project create PROJECT --url URL [--ref REF]
  [--apply-repos | --no-apply-repos]
dim project create PROJECT --root ALIAS [--url URL] [--ref REF]
  [--protect PATTERNS] [--mirror]
  [--apply-repos | --no-apply-repos]
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

`project create --url` fetches the selected external ref before creating
Project state and requires `.dim/repos.yml` there. Its single `root: true`
mapping key supplies the stable root alias and its URL must match the bootstrap
URL. The CLI imports that root through the invoking host Git CLI using the
manifest's protection policy. `--ref` selects the manifest revision and
sets the root ref when the manifest omits one; a differing manifest root ref is
an error. `--apply-repos` applies the remaining
set, `--no-apply-repos` skips it, and omitting both prompts only in a TTY. A
declined or non-interactive default must print `dim repo apply PROJECT --yes`
as the clone-free later path.

`project create --root` is the explicit manifest-free form. It creates the
Project and registers an empty or imported root under the supplied alias.
`--protect` and `--mirror` require this form because manifest bootstrap reads
those policies from `.dim/repos.yml`. Apply flags are mutually exclusive and
root/bootstrap options cannot be combined with `--repos FILE`.

`remove` removes only DIM Project metadata. It preserves the managed Git
organization and repositories and refuses while a workspace references the
Project. `purge` has the same reference check and permanently deletes the
DIM-managed Git organization and repositories after explicit confirmation.

## Repositories

```bash
dim repo add PROJECT ALIAS [URL] [--root] [--ref BRANCH] [--protect PATTERNS] [--mirror]
dim repo fetch PROJECT ALIAS [--prune]
dim repo push PROJECT ALIAS REF...
dim repo plan PROJECT [--file FILE]
dim repo apply PROJECT [--file FILE] [--yes]
dim repo protect PROJECT ALIAS
dim repo list PROJECT
dim repo show PROJECT ALIAS
dim repo delete PROJECT ALIAS --yes
dim repo url PROJECT ALIAS
dim repo url --workspace PROJECT ALIAS
```

Every repository alias belongs to one Project namespace and is always
supplied explicitly; DIM never derives it from a URL. `add` without a URL
creates an empty repository and leaves protection pending. `add` with a URL
uses the invoking CLI's host `git` process to transfer the source into managed
Gitea, then applies protection. The default import copies branches and tags;
`--mirror` explicitly copies every source ref, including server-private refs.
Workspace creation also applies pending
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
managed root's optional `.dim/repos.yml`. Because that file is read without a
local checkout, its Git URLs must be network/scp-style URLs or absolute
filesystem paths; relative filesystem paths are rejected as ambiguous. An
explicit local `--repos`/`--file` manifest is only an input to reconciliation
and is never written over the root repository's tracked `.dim/repos.yml`.

`repo delete --yes` deletes an unused non-root repository from managed Gitea
and Project metadata. It rejects the Project root and any Project referenced
by a workspace.

The CLI asks before applying a discovered root file in a TTY. Non-interactive
use requires `--yes` for `repo apply` or `--apply-repos` during root
registration; it never answers its own prompt. `--no-apply-repos` explicitly
skips discovery without disabling later clone-free `repo apply`.
Repository-set planning and all state transitions use the admin API. External
clone/push transport is a local CLI adapter so current host credential helpers,
SSH configuration, and SSH agent are used. The managed Gitea credential is
applied only to the destination push.
If root transfer fails after Project creation, repeating `project create` with
the same URL re-reads the manifest and derives the same root alias before
retrying that failed transfer. The explicit `--root` form likewise retries
with the same alias and origin. Neither form adopts
an unrelated existing Project, a ready root, or a different origin.

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

`repo fetch` reuses the external `origin` URL recorded by `repo add`. External
branches are projected into managed branches under `upstream/` (for example,
external `refs/heads/main` becomes managed `refs/heads/upstream/main`).
Updates to those tracking branches are forced so an external force-push can be
represented without changing DIM-owned branches. Tags retain their names and
an existing tag that points to a different object rejects the fetch.
`--prune` deletes only managed `upstream/*` branches that disappeared
externally. It never deletes other managed branches or tags.

`repo push` requires one or more explicit, full `source:destination` branch or
tag refspecs. It is non-forced and does not infer a destination or strip an
`upstream/` prefix.

Both operations use temporary bare Git storage. The invoking host Git process
supplies credentials for the external URL, while DIM credentials are installed
only for the separate managed-Gitea command.

## CI runners

```bash
dim ci runner enable PROJECT [--cpus COUNT] [--memory SIZE] [--pids-limit COUNT]
dim ci runner list
dim ci runner status PROJECT
dim ci runner logs PROJECT
dim ci runner restart PROJECT
dim ci runner stop PROJECT
dim ci runner disable PROJECT --yes
dim ci runner defaults show
dim ci runner defaults set --cpus COUNT --memory SIZE --pids-limit COUNT
dim ci runner defaults reset
```

Each enabled Project has at most one organization-scoped runner with concurrency
one and the fixed workflow label `dim`. The managed organization contains all
repositories registered to that Project, so root and non-root repositories can
use the same runner. Its supervisor, nested container
daemon, job containers, data volume, and resource limits are independent from
every workspace. The runner receives neither workspace credentials nor a host
container-engine socket. The initial adapter also maps `ubuntu-24.04` to its
compatible job image so a workflow shared with GitHub does not require a
provider-specific `runs-on` edit.

The runner also advertises `dim-container-integration` in host mode. Here
"host" is the isolated Project CI runner container, not the DIM host. This
mode is reserved for the reviewed container-integration workflow job because
its controller Unix sockets and nested Docker bind sources must share the
runner container's filesystem namespace. Ordinary check jobs remain in
disposable job containers. Re-enabling a runner replaces its provider
registration so the declared label contract is reconciled.

When `/dev/kvm` is available to the DIM host, the container executor MUST pass
that device and its supplemental group into the managed runner and advertise
`dim-release-gate` in host mode. It MUST omit both the device and label when
KVM is unavailable. This capability belongs to the executor contract, not the
Gitea coordinator adapter.

Effective resources resolve in this order: Project overrides, configured user
defaults, then the built-in `4 CPU / 8 GiB / 2048 PID` fallback. `enable` with
resource flags records a Project override. Without flags it inherits defaults;
`restart` preserves an existing override.

The CI coordinator and execution backend are separate contracts. The initial
coordinator adapter registers against managed Gitea Actions, while lifecycle
state, CLI, cgroup resources, and the container executor use provider-neutral
CI terms. Registration credentials are not persisted in DIM state.

The initial executor is a pinned DinD system container isolated by Sysbox. A disposable-QEMU
executor may later implement the same runner contract and advertise
`dim-qemu`; it is not part of the initial container-runner lifecycle.

## Workspaces

```bash
dim workspace create PROJECT WORKSPACE \
  [--profile PROFILE ...] \
  [--cpus COUNT] [--memory SIZE] [--pids-limit COUNT]

dim workspace list
dim workspace show WORKSPACE
dim workspace resources WORKSPACE [--cpus COUNT] [--memory SIZE] [--pids-limit COUNT]
dim workspace align WORKSPACE [--reset --yes]
dim workspace exec WORKSPACE -- COMMAND [ARGS...]
dim workspace run WORKSPACE TASK [ARGS...]
dim workspace setup WORKSPACE
dim workspace update WORKSPACE [--profile PROFILE ... | --clear-profiles]
dim workspace start WORKSPACE
dim workspace restart WORKSPACE
dim workspace stop WORKSPACE
dim workspace discard WORKSPACE --yes
```

`create` clones the Project root repository/ref at `/workspace/project` and
runs its `.dim` setup contract. DIM directly manages no other checkout; the
root repository lifecycle owns additional clones and nested services.
Resource flags are stored in the workspace record. Environment configuration
provides their defaults but does not force one limit set on every workspace.
`resources` requires at least one flag, applies the complete effective limit
set to the existing top-level container with `docker update`, and persists
state only after the runtime accepts the update. Omitted flags retain their
current per-workspace values. Running and stopped containers are supported.
At creation, DIM records whether host `/dev/kvm` exists as a character device.
Supported trusted workspaces receive that device and its host group
automatically; gVisor workspaces record KVM as unavailable.
The runtime backend defaults to the backend recorded during installation.
Omitting `--profile` stores an empty profile list and starts ordinary
non-profiled Compose services.

Running workspaces do not change when Project metadata or the root remote
changes. `start` applies the configured root ref to a stopped workspace before
setup. `restart` stops a running workspace and performs the same start,
fast-forward, and setup sequence. Dirty root checkouts and non-fast-forward
updates are rejected without reset.

`workspace align` is the checkout-only recovery path. It fetches the
configured root ref, switches a clean checkout back to the corresponding
local branch, and fast-forwards it without running Project setup or changing
containers. `--reset --yes` instead resets that configured branch to the
fetched ref; other local branches remain available. Top-level `dim run` and
`dim exec` are convenience aliases for `dim workspace run` and `dim workspace
exec`. Other workspace lifecycle commands exist only below `dim workspace`.

`run` dispatches through `.dim/entrypoint.sh` when present. `exec` always
bypasses it. `discard` requires `--yes`, attempts project teardown, and removes
the top-level container, inner-engine volume, and workspace state.

`doctor` can diagnose the host without a configured workspace backend.
`doctor configure-backend [BACKEND]` verifies and records a backend without
requiring the controller to be running.

## External URL commands

Host configuration is managed through:

```text
dim external-url dns-provider add DRIVER --name NAME [--argument STRING]
dim external-url dns-provider list [--json]
dim external-url dns-provider remove NAME
dim external-url ingress add DRIVER --name NAME --description TEXT
  --scheme SCHEME [--argument STRING]
dim external-url ingress list [--json]
dim external-url ingress verify NAME
dim external-url ingress remove NAME [--cleanup-dns]
```

Invalid ingress driver arguments are client errors. The admin API returns HTTP
400, and its message links to the ingress configuration documentation when a
driver-specific JSON object is missing or malformed. An ingress that references
a named infrastructure provider must be rejected unless that provider is
already configured.

Drivers may own host services required by an ingress. Those services are
reconciled by the managed controller after configuration changes and must not
require a separate setup command. Driver-private runtime values must be kept
under DIM state rather than added to the opaque user-supplied argument.
Managed Caddy may additionally reserve explicitly configured exact hostnames
beneath its wildcard domain for static HTTP(S) upstreams. Such routes must be
validated as credential-free origins and take precedence over workspace
routes without granting workspaces authority to create or change them.

Workspace-scoped URL operations are:

```text
dim external-url discover [--workspace WORKSPACE] [--json]
dim external-url request [--workspace WORKSPACE] --ingress NAME
  [--subdomain NAME] [--container NAME ...] --port PORT [--protocol http|https]
dim external-url list [--workspace WORKSPACE] [--json]
dim external-url revoke URL_ID [--workspace WORKSPACE]
dim host-input get PROVIDER KEY [--parameters STRING]
```

The ingress `argument` is an opaque string interpreted only by its driver.
DNS provider plugins register named drivers through the instance-scoped DIM
plugin extension registry. Provider configuration and Caddy's per-record
`dnsArgument` remain opaque strings interpreted only by that driver; the
External URLs plugin must not depend on a provider implementation package.
Drivers return public URLs rather than asking the common controller to derive
domains. The request contains a complete relative subdomain. By default it
must begin `WORKSPACE--`; an omitted value receives the first unused
`WORKSPACE--INDEX` name. An ingress may replace this default with a fail-closed
HTTP(S) or Unix-socket policy webhook. DIM revalidates any webhook replacement
and prevents hostname conflicts. Workspace discard revokes all routes
authenticated by that workspace grant before removing the grant.

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
