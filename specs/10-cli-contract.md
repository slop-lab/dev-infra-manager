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
- Commands that inspect or mutate DIM state are clients of the managed
  host-admin controller API. Long-running calls and `exec`/`run` use controller
  command sessions rather than starting host runtime commands in the CLI.
  Local process adapters are limited to external Git transport (`repo` import,
  fetch, publish, and `x git`), the Git credential helper, controller bootstrap,
  and pre-controller backend diagnosis. They obtain DIM-owned state and
  credentials through the admin API.
- The managed controller uses separate Unix sockets in separate host runtime
  directories. The host-admin socket is mode `0600` and is never mounted into
  a workspace. The workspace socket accepts workspace-scoped grants and is
  mounted only into the trusted workspace root. The agent socket accepts a
  distinct agent grant and dispatches only routes explicitly registered for
  the `agent` audience. A grant from one socket cannot authenticate to another.

## Streaming command sessions

The host-admin API exposes an asynchronous command-session contract:

- `POST /v1/sessions` starts an allowlisted operation and returns an opaque ID.
- `GET /v1/sessions/ID/events` streams ordered SSE events for command stages,
  stdout, stderr, exit status, final result, and sanitized errors.
- `POST /v1/sessions/ID/input` forwards base64-encoded input bytes and may close
  stdin.
- `DELETE /v1/sessions/ID` cancels the active process.

Sessions retain a bounded post-completion lifetime so a reconnecting client can
replay events by sequence. Command events never contain argv because arguments
may contain runtime secrets. The CLI is one client of this contract; a future
web UI can use the same lifecycle after an authenticated transport proxy is
defined. The session API remains host-admin-only and is not exposed through a
workspace grant.

## Projects

```bash
dim project create PROJECT [--repos FILE] [--yes]
dim project create PROJECT --bootstrap-git-url URL [--bootstrap-git-ref REF]
  [--apply-repos | --no-apply-repos]
dim project create PROJECT --root ALIAS [--bootstrap-git-url URL] [--bootstrap-git-ref REF]
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

`project create --bootstrap-git-url` fetches the selected external Git ref
before creating Project state and requires `.dim/repos.yml` there. Its single
`root: true`
mapping key supplies the stable root alias and its URL must match the bootstrap
URL. The CLI imports that root through the invoking host Git CLI using the
manifest's protection policy. `--bootstrap-git-ref` selects the manifest
revision and sets the root ref when the manifest omits one; a differing
manifest root ref is an error. A same-origin set applies automatically;
`--apply-repos` approves a set adding origins and `--no-apply-repos` skips it.
A declined or non-interactive multi-origin default must print
`dim repo apply PROJECT --yes` as the clone-free later path.

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
dim repo publish PROJECT [ALIAS]
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
`root`, `ref`, `protect`, `blockForcePush`, `import`, and `publish`. `protect`
selects refs requiring reviewed changes and explicit host/owner push and merge
allowlists. `blockForcePush` selects refs that retain ordinary writer push and
merge permissions while rejecting force pushes; a ref named in both receives
the stronger `protect` policy. `import` maps managed branch
names to external branch names. `publish` independently authorizes managed
source branches and connection-relative destinations, which the import
namespace projects back to external names. An explicit import mapping copies
only its named external branches and does not import tags.
`project create --repos` requires exactly one
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

When every discovered repository resolves to the bootstrap root's external
origin (or is empty), `project create --bootstrap-git-url` applies the complete set without
another prompt because it introduces no additional host Git origin. Otherwise
the CLI asks in a TTY and non-interactive use requires `--apply-repos`.
`repo apply` requires `--yes` in non-interactive use. `--no-apply-repos`
always skips discovery without disabling later clone-free `repo apply`.
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
`rootRef`, `protectedPatterns`, and `forcePushBlockedPatterns`; YAML `ref`,
`protect`, and `blockForcePush` are file-format adapters, not API fields.

Host and workspace URLs never contain credentials.

`repo fetch` reuses the external `origin` URL recorded by `repo add`. External
branches selected by an explicit `import` mapping retain their mapped managed
names beneath `upstream/`; otherwise external branches retain their names
(for example, external `refs/heads/main` becomes managed
`refs/heads/upstream/main`).
Updates to those tracking branches are forced so an external force-push can be
represented without changing DIM-owned branches. Tags retain their names and
an existing tag that points to a different object rejects the fetch.
`--prune` deletes only managed `upstream/*` branches that disappeared
externally. It never deletes other managed branches or tags.

`repo publish PROJECT [ALIAS]` pushes only the non-forced branch mappings in
the reviewed repository-set `publish` policy. With no alias it publishes every
repository that has a non-empty policy, in alias order. A repository without a
policy cannot be published explicitly. Namespace prefixes are applied only at
the external boundary.

Both operations use temporary bare Git storage. The invoking host Git process
supplies credentials for the external URL, while DIM credentials are installed
only for the separate managed-Gitea command.

## CI runners

```bash
dim ci runner create PROJECT RUNNER EXECUTOR [--cpus COUNT] [--memory SIZE] [--pids COUNT]
dim ci runner list
dim ci runner status PROJECT RUNNER
dim ci runner logs PROJECT RUNNER
dim ci runner start PROJECT RUNNER
dim ci runner restart PROJECT RUNNER
dim ci runner stop PROJECT RUNNER
dim ci runner delete PROJECT RUNNER --yes
dim ci runner defaults show
dim ci runner defaults set --cpus COUNT --memory SIZE --pids COUNT
dim ci runner defaults reset
```

`create` rejects an existing Project/runner identity. `start`, `restart`, and
`stop` require an existing runner; `start` additionally requires its phase to
be `stopped`. `delete` is the only command that removes provider registration,
local data, and lifecycle state.

`RUNNER` is a Project-scoped stable identity and `EXECUTOR` is `sysbox` or
`qemu`. A Project may enable any number of independently managed runners. The
executor kind is fixed until that runner is deleted. The organization-scoped Sysbox runner has
concurrency one and label `dim`. The
QEMU executor boots a disposable VM only after a queued job selects label
`dim-qemu`. The managed organization contains all
repositories registered to that Project, so root and non-root repositories can
use the same runner. Its supervisor, nested container
daemon, job containers, data volume, and resource limits are independent from
every workspace. The runner receives neither workspace credentials nor a host
container-engine socket. The initial adapter also maps `ubuntu-24.04` to its
compatible job image so a workflow shared with GitHub does not require a
provider-specific `runs-on` edit.

Managed CI runner and DIM-owned workspace container engines MUST use a host-scoped, managed Docker Hub
pull-through cache. The cache MUST have persistent filesystem storage, MUST NOT
publish a host port or contain upstream credentials, and MUST remain outside
Project-defined networks. Workspace engines and Sysbox runners may reach it on the control network;
QEMU guests may reach it only through a supervisor-local relay. Verification
harnesses MAY extend that relay into nested KVM guests and test-created DinD
daemons, but ordinary Project and example definitions MUST NOT depend on the
managed cache. Cache use MUST
NOT expose a host container-engine socket or make disposable runner state
persistent. Cache misses remain ordinary anonymous upstream pulls.

The QEMU supervisors form a Project-scoped scheduler with one capacity per
named runner. They MUST coordinate through a shared managed dispatch volume and
atomically claim demand so duplicate provider deliveries cannot boot more than
one VM for a job. The scheduler MUST persist selected `queued`, `in_progress`,
and `completed` workflow-job state before acknowledging each webhook. Queued demand
MUST remain pending until the coordinator reports that the job entered
progress or completed; a disposable VM exiting, including after consuming a
different stale coordinator task, MUST NOT silently discard that demand.
Supervisor failures use bounded retry delay and MUST NOT terminate the webhook
server. After a supervisor or container restart, persisted queued demand MUST
resume without another webhook delivery. Claims MUST use renewable leases so a
removed or failed capacity cannot strand demand. Completed demand MUST NOT
start a VM. Workflows select only the forge-neutral `dim-qemu` capability and
MUST NOT name a managed capacity.

The runner also advertises `dim-container-integration` in host mode. Here
"host" is the isolated Project CI runner container, not the DIM host. This
mode is reserved for the reviewed managed-workspace integration job because
its controller Unix sockets and nested Docker bind sources must share the
runner container's filesystem namespace. Ordinary check jobs remain in
disposable job containers. Re-enabling a runner replaces its provider
registration so the declared label contract is reconciled.

When `/dev/kvm` is available to the DIM host, DIM MUST NOT pass it into the
Sysbox runner. A trusted runc supervisor receives only that device, boots an
isolated QEMU VM, and registers the runner inside that VM as ephemeral before
each job. Untrusted workflow code receives nested KVM inside the VM, not the
host device or container engine. The supervisor deletes the overlay after the
job and has no waiting VM while idle. Creating this runner fails when host
KVM is unavailable.

The managed Gitea adapter MUST allow webhook delivery only to exact enabled
QEMU supervisor hostnames. It MUST NOT broaden Gitea's webhook allowlist to
arbitrary private-network targets.

Effective resources resolve in this order: runner overrides, configured user
defaults, then the built-in `4 CPU / 8 GiB / 2048 process` fallback. `create`
with resource flags records a runner override. Without flags it inherits
defaults; `restart` preserves an existing override. Sysbox applies all three
limits to its container cgroup. QEMU requires an integer CPU count and maps CPU
and memory to guest vCPUs and RAM; its supervisor receives the same CPU limit
and guest RAM plus 2 GiB. A process override is rejected for QEMU because the
supervisor's process cgroup is not a guest process limit.

The CI coordinator and execution backend are separate contracts. The initial
coordinator adapter registers against managed Gitea Actions, while lifecycle
state, CLI, cgroup resources, and the container executor use provider-neutral
CI terms. Registration credentials are not persisted in DIM state.

The normal executor is a pinned DinD system container isolated by Sysbox. The
QEMU executor uses a pinned supervisor image, a checksum-verified
Ubuntu cloud image, and a pinned Gitea runner binary. Its reusable registration
token stays outside the guest and is sent over temporary SSH only for
registration; Gitea revokes the ephemeral runner credential upon job assignment.

## Workspaces

```bash
dim workspace create PROJECT WORKSPACE \
  [--profile PROFILE ...] \
  [--kvm | --no-kvm] \
  [--cpus COUNT] [--memory SIZE] [--pids COUNT]

dim workspace list
dim workspace show WORKSPACE
dim workspace resources WORKSPACE [--cpus COUNT] [--memory SIZE] [--pids COUNT]
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
At creation, DIM records the immutable effective KVM policy. When KVM is
available for the selected backend and neither policy flag is supplied, an
interactive terminal asks whether to grant it and recommends acceptance.
Non-interactive creation retains automatic enablement unless `--no-kvm` is
supplied. `--kvm` requires the device to be available rather than silently
downgrading. gVisor workspaces cannot receive KVM.
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
fetched ref, discarding tracked changes and non-ignored untracked files so it
can recover after a failed setup; ignored files and other local branches remain
available. Top-level `dim run` and
`dim exec` are convenience aliases for `dim workspace run` and `dim workspace
exec`. Other workspace lifecycle commands exist only below `dim workspace`.

`run` dispatches through `.dim/entrypoint.sh` when present. `exec` always
bypasses it. `discard` attempts project teardown and removes the top-level
container, inner-engine volume, and workspace state.

Commands that permanently delete Projects, repositories, CI runners, or
workspaces accept confirmation from an interactive terminal. In a
non-interactive shell they require the explicit `--yes` option.

`doctor` can diagnose the host without a configured workspace backend.
`doctor configure-backend [BACKEND]` verifies and records a backend without
requiring the controller to be running.

## External URL commands

Host configuration is managed through:

```text
dim external-url dns-provider add DRIVER --name NAME [DRIVER_ARGUMENT...]
dim external-url dns-provider list [--json]
dim external-url dns-provider remove NAME
dim external-url ingress add DRIVER --name NAME --description TEXT
  --scheme SCHEME [DRIVER_ARGUMENT...]
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

Provider and ingress arguments are forwarded as an ordered string array and
interpreted only by the selected plugin driver. The CLI does not encode a
driver-specific JSON schema.
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

Runs the local Git CLI with a host-only managed maintainer credential supplied
through environment and a one-command credential helper. The admin API returns
the provider-neutral `username` and `password` credential shape; it does not
expose the workspace writer or provider-administrator credential. The command
does not put credentials in argv or repository URLs. Existing Git credential
helpers and SSH agents remain valid alternatives. The maintainer may push
protected refs through the provider's explicit push allowlist; force-push
policy is unchanged.

`git setup` installs a URL-scoped, path-aware global Git credential helper for
ordinary host-side Git commands. The requested URL path remains available for
future Project-aware gateway routing. Credential retrieval also reconciles
the host maintainer's repository access and existing protected-ref allowlists.

## Diagnostics and administration

```bash
dim doctor
dim plugin list
dim admin service ensure
dim admin service credentials --show-secrets
```

Administrative commands are omitted from the default root help.
