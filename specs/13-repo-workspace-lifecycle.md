# Project, Repository, and Workspace Lifecycle

## State and identities

DIM stores schema-versioned Project and workspace records below
`DIM_STATE_ROOT`, defaulting to `~/.local/state/dim`.

```text
<stateRoot>/projects/<project>.json
<stateRoot>/workspaces/<workspace>.json
<stateRoot>/assets/project-roots/<project-id>/<root-commit>/
<stateRoot>/services/gitea.json
<stateRoot>/locks/project-<project>.lock
<stateRoot>/locks/ci-runner-<project>.lock
<stateRoot>/locks/qemu-project-hook-<project-id>.lock
<stateRoot>/locks/workspace-<workspace>.lock
```

**LIFECYCLE-LOCK-001:** Each lifecycle lock MUST use a kernel-held exclusive
guard and an atomically published owner record. Owner record version `1`
contains the PID, Linux boot ID in canonical lowercase UUID syntax,
`/proc/<pid>/stat` process-start ticks, acquisition timestamp, and a
cryptographically random nonce. A 36-character string with misplaced hyphens
is not a valid boot ID. Acquisition time is diagnostic only and MUST NOT make a
matching live process instance reclaimable. A different boot ID or
process-start identity proves PID reuse; an absent process proves death. Either
state is reclaimable while the kernel guard serializes the ownership
transition.

Malformed, unsupported, unreadable, or otherwise unverifiable owner state
MUST fail closed with a bounded timeout and an actionable diagnostic. Owner
publication MUST use a complete temporary file followed by atomic rename;
unpublished temporary files left by a crash are not owners and are cleaned
only while holding the guard. Release MUST verify the acquiring nonce while
holding that same guard before removing the owner record, and MUST release
only that acquisition. Independent acquisitions from one process contend like
acquisitions from different processes.

Project, CI-runner, Project-hook-publication, workspace-setup, and workspace
reconciliation lock identities remain distinct. Their required acquisition
order and release boundaries are unchanged by owner reclamation.

Project and workspace records use persistent IDs distinct from display names.
Project records use schema version `4` and require `giteaOrganizationId`. The
field is `null` before organization identity has been established and otherwise
MUST be a positive integer. A `ready` Project MUST have a non-null
`giteaOrganizationId`. Incompatible pre-stable schemas are rejected without
mutation unless a release explicitly defines a migration.

Host lifecycle state uses schema version `2`. It has exactly the required
`schemaVersion`, `phase`, `resumeWorkspaces`, `restartCiRunners`,
`resumeManagedContainers`, and `updatedAt` fields, plus optional `error`.
Allowed phases are `ready`, `stopping`, `stopped`, `starting`, and `error`.
Resume-list members MUST be valid names; each runner target MUST contain
exactly valid string `project` and `name` fields; timestamps and any error MUST
be non-empty strings. Malformed, missing, mistyped, unknown, or unsupported
state MUST be rejected without mutation or recovery dispatch.
`restartCiRunners` is durable restart intent captured before shutdown,
alongside workspace and other managed-container recovery lists. Host start does
not infer runner restart authority from current runner state. Schema `1` is
rejected without a compatibility or migration path.

## Project namespace

The built-in managed Git service is one DIM-owned Gitea instance. Each Project
owns the reserved organization `dim-<project>` and repository aliases are
scoped below it:

```text
dim-acme/root
dim-acme/product
dim-acme/environment
```

Project metadata contains its name/ID, namespace, trusted Gitea organization
ID, repository catalog, and exactly one root repository/ref when runnable.
Infrastructure implementation belongs to the root repository, not the Project
state.

Claims precede Gitea mutations. Project and repository reconciliation is
serialized, records errors for diagnosis, and rejects unmanaged identity
collisions.
DIM MUST disable regular-user organization creation in managed Gitea with
`[admin] DISABLE_REGULAR_ORG_CREATION`, whose container environment mapping is
exactly `GITEA__admin__DISABLE_REGULAR_ORG_CREATION=true`.

Managed Gitea reconciliation MUST hold one service-scoped lock across service
state claim and publication, network and volume reconciliation, container
inspection or creation, policy inspection and repair, restart, readiness,
credential read or publication, and webhook configuration. No concurrent
Gitea reconciliation may inspect or mutate those resources within that
critical section. After a successful ownership inspection, container start,
policy inspection and editing, restart, and credential access MUST use only the
returned immutable container ID, never the deterministic name.

Managed Gitea network and volume inspection MUST classify a resource as absent
only when the trimmed Docker diagnostic equals, case-insensitively,
`Error response from daemon: network <expected-name> not found` for a network
or `Error response from daemon: get <expected-name>: no such volume` for a
volume. An exact network-not-found diagnostic cannot establish volume absence,
an exact volume-not-found diagnostic cannot establish network absence, and a
diagnostic for another name cannot establish either. Exact absence is the sole
path to creating the network or volume. Every other non-successful inspection
MUST propagate before that resource or any later reconciliation step is
mutated.

The managed credential file is absent only when its in-container reader
returns the reserved result produced by an explicit test that the credential
path does not exist. DIM MUST propagate permission, command, malformed-content,
and every other read failure without creating users or publishing replacement
credentials. The managed Gitea configuration MUST contain exactly one
`DISABLE_REGULAR_ORG_CREATION` key in `[admin]`, and its value MUST be `true`.
A missing, false, or duplicate key is non-canonical. After repairing the
policy, DIM MUST restart the inspected container and reinspect the policy on
that same immutable ID before readiness, credential reconciliation, or ready
state publication.

When organization creation succeeds, DIM MUST validate the returned positive
ID and exact reserved username, persist that ID while the Project is still
non-ready, and only then publish the Project as `ready`. A retry with a trusted
ID MUST verify a lookup by reserved name against both that exact ID and exact
username before continuing. A retry whose ID is null MUST issue the create
request and MUST NOT adopt a same-name organization. HTTP `422` in that state
is a fail-closed collision that requires administrator reconciliation.

## Repository creation and import

Empty repository creation is the primary operation. It returns separate host
and workspace endpoints without credentials. Users may populate it with any
standard Git commands.

Protection is pending until the initial push and must be applied before the
root can create or update a workspace. The default CLI import transfers
branches and tags before applying protection; `--mirror` explicitly includes
all source refs. An imported repository remains non-ready while protection is
pending. During that interval only DIM's trusted transfer identity may write.
DIM revokes transfer authority before applying protection, and grants ordinary
repository users only after protection succeeds. Transfer or protection
failure leaves the repository non-ready and non-writable by ordinary users.

Deleting a repository MUST reject the selected target while its phase is
`importing`, before any Gitea or Project-state mutation. An importing sibling
MUST NOT block deletion of a different `ready` target.

External sources are accessed only through the local Git CLI and its existing
credential configuration. DIM does not provision external Git providers or
proxy Git traffic. A repository retains its explicit external connection so
`repo fetch` can project remote branches under managed `upstream/*` and
`repo publish` can publish only reviewed, non-forced branch mappings. Omitting
the repository alias publishes every repository with configured mappings.
DIM's self Project maps its managed promotion branch to the canonical
development branch, keeping the canonical release branch outside routine
development publication.

## Root workspace contract

A workspace binds permanently to a Project ID and directly clones only the
configured root repository/ref at:

```text
/workspace/project
```

`/workspace/project` is mutable Project data and is never a source of trusted
lifecycle execution. For create, start, update, and restart, DIM resolves a
single concrete branch covered by the root repository's applied protection,
pins its exact commit, and atomically publishes the complete commit tree below
the controller-owned content-addressed assets path. At the same selection
point, DIM resolves the requested ref for every other Project repository to an
exact commit. The workspace record uses schema version `5`. Its immutable
`repositorySnapshot` is a complete object keyed by every Project repository
alias, and it MUST NOT be empty or omit an alias. Each entry has exactly a
credential-free `workspaceUrl`, `phase: ready`, its root role, `requestedRef`,
the resolved `ref`, and the exact `commit`, including the root entry. No
non-ready repository may appear in the snapshot. For a root with a configured
ref, `requestedRef` and the resolved `ref` record that selected concrete ref.
When the root ref is omitted, `requestedRef` MUST remain the literal `HEAD`
while `ref` records the concrete protected branch to which symbolic `HEAD`
resolved. The root entry's resolved ref and commit MUST equal the workspace's
separate `rootRef` and `rootCommit`. The root's published full-tree asset
remains recorded separately in `rootSnapshotPath`; the repository snapshot
does not replace that path. Older workspace schemas are rejected without
migration.

The selected Project-root snapshot is mounted read-only only into the trusted
outer workspace. It is not mounted into an agent runtime. Setup, entrypoint,
teardown, Compose fallback, and relative helpers or build contexts execute from
that snapshot. `DIM_PROJECT_ROOT` explicitly names the mutable checkout for
lifecycle code that needs Project data. Reserved lifecycle files must not be
symbolic links, and links in the snapshot must not escape its tree.

Creation records an immutable effective KVM capability. An interactive create
asks before granting available KVM and recommends it; explicit `--kvm` and
`--no-kvm` make automation deterministic. Non-interactive omission preserves
automatic enablement. When host `/dev/kvm` is readable and writable and the
Sysbox workspace supports it, DIM passes the device directly into the trusted
workspace container and adds the device's host GID as a supplemental group.
DIM does not place the workspace container in a VM.
With KVM disabled, DIM MUST omit that explicit device and supplemental-group
grant. Because the trusted Project lifecycle container is privileged, device
path visibility inside it is not an isolation contract and MUST NOT be used as
a lifecycle, setup, readiness, or restart check.

The root repository owns the optional:

```text
.dim/setup.sh
.dim/entrypoint.sh
.dim/teardown.sh
.dim/docker-compose.yml
.dim/repos.yml
```

DIM probes each optional lifecycle file inside the immutable root snapshot.
Probe exit code `0` means present and only exit code `1` means absent. Every
other result is a probe failure and MUST abort before DIM dispatches a setup,
entrypoint, teardown, Compose, or direct-command fallback.

It also owns checkout and reconciliation of any additional Project
repositories. DIM supplies a read-only runtime manifest and environment to
`.dim/setup.sh`, `.dim/entrypoint.sh`, `.dim/teardown.sh`, and `exec`:

The optional `.dim/repos.yml` is a repository-connection set, not a Project or
workspace manifest. Its `repositories` mapping keys are stable Project-scoped
aliases, including the single root alias used by lifecycle code and agents.
When the built-in Gitea service creates repositories, it MUST enable the
built-in issue tracker for the root and disable it for every non-root
repository. Reconciliation MUST NOT change this setting on an existing
repository; issue migration and legacy repository settings are outside the
repository-set lifecycle.
Registering a root automatically applies this file when every entry uses the
bootstrap origin (or is empty); additional origins require explicit or
interactive approval. Applying it never removes a managed repository omitted
from the file. A standalone `repos.yml` with
exactly one `root: true` may be passed to `project create --repos`.
The normal bootstrap uses `project create --bootstrap-git-url URL` to read
`.dim/repos.yml` from the selected external ref before creating Project state.
The manifest's
single `root: true` mapping key fixes the root alias. The command can then
automatically apply a same-origin set, or apply, skip, or interactively offer a
set that adds origins, without a local clone. A skipped set remains available
through `repo plan` and `repo apply` with no `--file`.
Manifest-free repositories use the explicit
`--root ALIAS --bootstrap-git-url URL` form.
The selected external bootstrap ref may differ from the managed root ref when
the root entry has an explicit `import` mapping. For example,
`--bootstrap-git-ref dev/root`
with `ref: main` and `import: {main: dev/root}` imports only the external
`dev/root` branch as managed `main`; subsequent root-manifest reads use managed
`main`.

```text
DIM_PROJECT_ID
DIM_PROJECT_NAME
DIM_PROJECT_ROOT
DIM_PROJECT_MANIFEST
DIM_WORKSPACE_NAME
DIM_WORKSPACE_BACKEND
DIM_WORKSPACE_KVM
DIM_NESTED_ENGINE
COMPOSE_PROJECT_NAME
COMPOSE_PROFILES
DIM_GIT_BASE_URL
```

`COMPOSE_PROJECT_NAME` identifies the reviewed Project runtime inside the
workspace container. DIM sets it to the stable workspace-local value
`dim-project`; it MUST NOT encode the DIM workspace name. The outer workspace
runtime remains independently identified by DIM-managed state.

The read-only runtime manifest also contains `hostAliases`, a mapping from
workspace-visible service names to one or more controller-resolved addresses.
DIM registers only endpoints granted to that workspace; Project lifecycle
code selects which nested services receive them. The canonical self-Project
generates a Compose override that applies the mapping to its private runtime,
which copies the reviewed aliases onto the agent container it creates.
This is a static bootstrap registry: address changes take effect when setup
reconciles the workspace and recreates the affected Project service.

The runtime manifest MUST also contain a `repositories` object copied from the
workspace's complete immutable `repositorySnapshot`, not reconstructed from
current Project state or only the desired root `.dim/repos.yml`. Entries are
keyed by validated repository alias and expose the credential-free workspace
URL, lifecycle phase, root role, requested ref, resolved ref, and exact commit.
This catalog is readable by Project lifecycle and agent environments; source
visibility is not a protected boundary. It MUST NOT expose external
credentials or grant protected-ref, merge, trusted-runtime, or host authority.
DIM clones only the root and leaves checkout paths and integrated development
layout to Project code.

The Project manifest uses schema version `2`, records the selected root commit,
and publishes the workspace
runtime's optional cgroup capability at `runtime.cgroups`. DIM enables the
capability automatically when the boundary is safe: the record reports
`status: delegated` only for a writable cgroup v2 hierarchy whose
nested runtime uses a supported `systemd` or `cgroupfs` driver and exposes the
`pids` controller. `none`, unknown drivers, cgroup v1, read-only hierarchies,
and missing required controllers report `status: unavailable` with a reason.
An unavailable optional capability does not prevent ordinary Project setup.
Project code may explicitly require it with `dim-project-cgroup require` and,
when running as root, create a delegated descendant without changing the
limits DIM applies to the Project boundary.

The workspace container additionally carries Git integration variables for
its whole lifetime (not only during setup/entrypoint/exec dispatch):

```text
DIM_GIT_USERNAME
DIM_GIT_TOKEN
DIM_GIT_USER_NAME
DIM_GIT_USER_EMAIL
GIT_ASKPASS
GIT_TERMINAL_PROMPT
DIM_CONTROLLER_SOCKET
DIM_CONTROLLER_TOKEN
DIM_AGENT_CONTROLLER_SOCKET
DIM_AGENT_CONTROLLER_TOKEN
```

Agent containers are ordinary, reviewed Project workloads. A Project may
declare one directly in `.dim/docker-compose.yml` or create one inside a
Project-owned private runtime started by `.dim/setup.sh`, then dispatch fixed
tasks from `.dim/entrypoint.sh`. Core owns none of its image, service, volume,
privilege, or task configuration. `dim workspace run WORKSPACE TASK` always
follows the checked-in `.dim/entrypoint.sh` contract when present.
The canonical self-Project's outer Compose graph contains only a private
rootless `agent-dind` daemon. Its daemon user adopts the numeric UID/GID that
owns the workspace checkout. That daemon owns the agent and ordinary development
containers, and the agent receives only its private daemon socket. Rebuilding
or replacing those inner workloads therefore requires no trusted workspace or
host runtime socket. The agent may run as UID 0 inside the rootless daemon's
user namespace: that UID maps to the non-root daemon UID which owns the
checkout, rather than to root in the trusted workspace or on the host.
The requirement that an agent process be non-root applies to containers whose
root identity carries host or trusted-workspace authority. It does not prohibit
UID 0 inside an explicitly rootless, subordinate-ID-mapped agent daemon.
Projects must not run the agent directly as root, or grant it sudo, in the
trusted outer workspace.

**WORKSPACE-SSH-PROXY-001:** A Project MAY expose a fixed `ssh-proxy` task as an
optional access pattern for its agent container. The task MUST target only the
Project's configured agent, forward raw stdio, and disable TTY allocation. The
caller MUST NOT be able to select another target or remote command. The task
MUST NOT publish a port. Authentication MUST be key-only. The SSH server MAY
run as root only inside the subordinate-ID-mapped agent container, where that
identity has no host or trusted-workspace root authority. The Project MUST
persist authorized keys outside agent-container recreation, generate host keys
at runtime, and provide a host-key fingerprint that the client verifies before
connecting. The top-level login MUST be a fixed non-root `dim-agent` account.
The canonical self-Project uses UID 1000 for that account across SSH sessions
and agent recreation. SSH root login MUST be disabled. Root authentication MUST
remain rejected when the client offers a key that is valid and authorized for
the `dim-agent` account.

The server MUST use a fixed shell bridge and a server-owned allowlist to create
each session environment from current runtime values. That environment MUST be
ephemeral, unreadable to clients before authentication, unavailable for client
override, and absent from persistent home state. Git credentials, identity,
and no-prompt behavior MUST be bounded to the agent, with safe directories
limited to `/workspace` and `/workspace/*`.

The fixed non-root login MUST have practical parity with ordinary agent tasks
for existing and newly created workspace content, persistent agent home, the
private nested Docker daemon, bounded Git, and explicitly constrained agent
endpoints. A Project MAY grant that parity with namespace-local recursive and
default ACLs. It MUST NOT transfer checkout ownership or make workspace content
world-writable. Docker access MUST use only the agent's private nested socket.
No host, trusted-workspace, or Project-runtime control socket may enter the
agent namespace. Constrained workspace-local External URL or QEMU sockets MAY
use creator mode `0666` only inside a private workspace namespace and MUST be
mounted read-only into the agent container. A trusted authorized key therefore
carries full agent authority, but no host or Project-runtime authority. Codex
remote access is one use case for this generic Project-owned task, not a DIM
feature or command.

Secret-bearing workloads must use a separate `secure-dind` daemon with
separate runtime storage. The agent daemon socket, agent home, workspace source,
and workspace Git credentials must not be mounted into that daemon.
The canonical self-Project exposes `codex`, an agent-container `bash` task,
and Project-owned `backup`/`restore` tasks that stream a gzip tar archive of
the agent home over stdout/stdin. Those canonical tasks temporarily stop the
agent and mount only its named home volume into a networkless archive
container, read-only for backup and read-write for restore. DIM does not
interpret or persist the archive.
Repository commands, including just recipes, run explicitly through the bash
task rather than growing one entrypoint task per recipe.

Before `create`, `start`, `setup`, or `update` runs Project setup, DIM must
ensure all three managed controller APIs are healthy. Host-admin, workspace,
and agent sockets live in separate state-root-specific runtime directories.
The mode-`0600` host-admin directory never enters a workspace. The workspace
socket directory is mounted at `/run/dim/controller` only in the trusted
workspace root. The agent socket directory is mounted separately at
`/run/dim/agent-controller`; the root receives a distinct agent grant and may
pass only that socket and grant to agent containers. Directory mounts keep
existing workspace mounts valid across controller restarts.

Host maintenance uses a controller-owned lifecycle record independent of
workspace state. While that record is not `ready`, `/healthz` remains a live
controller response carrying `ready: false`, `/readyz` returns `503`, and only
host status/start administration is accepted. Shutdown uses stop semantics,
never Project teardown or volume removal. A previously ready workspace is
restored through the phase-aware start/setup path, so a merely running outer
container cannot make the host ready. Repeating host start after partial
failure uses the durable recovery intent, skips targets already ready, and
clears those lists only after every target succeeds.

Every ordinary built-in or plugin host-admin operation MUST acquire the host
lifecycle lock before dispatch, confirm the host is `ready`, and retain that
admission until it completes. Host shutdown MUST acquire the same lock before
capturing its workspace, CI-runner, and managed-container recovery targets, so
target capture and service drain wait for admitted operations. A later
ordinary operation that waited behind maintenance MUST reread host state after
acquiring the lock and reject without dispatch when the host is not `ready`.
Host start owns its lifecycle admission and performs recorded workspace start
or immutable setup replay within that operation; those recovery calls MUST NOT
be blocked by attempting ordinary workspace admission again.

CI-runner recovery is determined by the host phase captured at the start of
that `host start` invocation. From `ready`, host start returns without recovery
dispatch. From `stopped`, `starting`, or `error`, a listed runner in `ready` is
left untouched, `stopped` is started, and `creating` or `error` is
ownership-safely stopped before start. From `stopping`, the same matrix applies
except that a listed `ready` runner is also ownership-safely stopped and
started because the shutdown transition may have been interrupted.

`POST /api/workspace/restart` accepts no body, derives the target exclusively
from the authenticated workspace grant, returns `202` before lifecycle work
begins, and asynchronously performs the ordinary stop, root fast-forward, and
setup sequence. A caller cannot name or restart another workspace.

Plugins must declare a non-empty audience set for every scoped controller
route. Omitted or invalid audiences reject plugin startup. Workspace discovery
includes only `workspace` routes; agent discovery includes only `agent` routes
and omits host inputs and the built-in restart route. The External URLs plugin
marks its workspace-scoped list/create/revoke routes for both audiences.

The standard workspace image also provides `dim-controller-proxy`. Reviewed root
lifecycle code may create a second Unix socket for a development container.
The proxy keeps the original controller socket and workspace grant outside
that container, removes client authorization, injects the trusted grant
upstream, and denies every request not accepted by an explicitly configured
capability. The External URL preset additionally validates the requested
ingress and filters discovery/list/revoke operations to its ingress allowlist. Projects
mount only the derived proxy socket directory into development containers.
The standard agent-policy helper accepts exact method/path rules, defaults
each route to an empty request body, filters discovery to those rules, and
removes host-input discovery.

Plugins register host administration routes separately from scoped controller
routes. Administration routes run only on the host-admin socket. Marking a
route for `agent` is an explicit security decision and does not expose built-in
workspace routes. A workspace route may be narrowed further by reviewed
Project-root proxy policy; registering an admin route never exposes it through
either scoped controller.

`DIM_GIT_BASE_URL` is Project-specific. Project lifecycle code appends its
own stable managed repository names and owns all checkout paths and
repository-to-service mappings. DIM does not export per-repository
variables. `COMPOSE_PROJECT_NAME`, `containerName`, and `dockerVolumeName`
are the only stable identifiers for Docker resources DIM creates for a
workspace; callers must read them from `dim workspace show WORKSPACE --json` rather
than reconstructing a naming scheme, which is not part of this contract and
may change.

**WORKSPACE-RESOURCE-OWNERSHIP-001:** Every DIM-managed workspace container
MUST carry and match the complete `dim.managed=true`, `dim.owner=dim`,
`dim.workspace`, `dim.project`, `dim.project-id`, `dim.repo`, `dim.backend`,
`dim.resource=workspace`, and `dim.digest` label set. Its inner-engine volume
MUST carry and match `dim.managed=true`, `dim.owner=dim`, `dim.workspace`,
`dim.project`, `dim.project-id`, `dim.resource=workspace-docker`, and
`dim.digest`. The container digest MUST be the collision-resistant SHA-256 of
the length-framed container name, workspace name, Project name and ID, root
alias, backend, `workspace` resource kind, and `container` Docker kind. The
volume digest MUST cover the length-framed volume name, workspace name, Project
name and ID, `workspace-docker` resource kind, and `volume` Docker kind.

An absent resource may be created or treated as the operation's documented
no-op. A same-name resource with absent, partial, malformed, foreign, or
mismatched labels MUST be treated as a conflict and MUST NOT be adopted,
relabeled, or modified. After creating a container or volume, DIM MUST inspect
the resulting same-name resource and accept it only if the complete ownership
identity matches. Every workspace container mutation, including start, stop,
resource update, replacement, teardown, and removal, MUST act only on the exact
container ID returned by successful ownership inspection. It MUST NOT fall
back to the deterministic name. Docker volumes expose no equivalent immutable
ID, so volume deletion necessarily remains name-based. Discard MUST validate
both resources before Project teardown and MUST reinspect the complete volume
ownership immediately before removal. A same-name replacement that wins after
an earlier inspection MUST remain untouched.

Reviewed Project lifecycle code may explicitly opt in to delegating a threaded
cgroup v2 subtree beneath the workspace cgroup to an unprivileged agent. The
agent may dynamically create descendants only below that root. Only the
delegated subtree and selected CPU/PID control files may be writable in the agent;
the workspace's aggregate host-enforced limits remain the parent boundary.
Threaded children may control CPU scheduling and PID counts, but must not be
presented as independent memory or I/O boundaries. The canonical self-Project
keeps ordinary `bash` task execution in the agent container's default group
and starts Codex in a dynamically created tool group so management commands retain a
responsive execution path.

The canonical self-Project stores the agent's home in a Project-owned outer
named volume. The private daemon receives that volume at a fixed path and
bind-mounts it into the inner agent as `/home/dim-agent`; task dispatch sets
`HOME` to that path. Agent configuration persists across task processes and
inner-container recreation, while workspace discard removes the volume through
reviewed teardown.

## Applying changes

DIM never applies Project or root remote changes to a running workspace
automatically.

- `start` selects and stages one approved root commit, starts a stopped runtime,
  fast-forward merges that commit, and runs setup. The built-in Compose fallback MUST
  force-recreate services because stopping the outer workspace also terminates
  their runtime processes; Project-owned setup remains responsible for its own
  equivalent reconciliation.
- `restart` selects and stages one approved root commit, then stops a running
  runtime and performs the same start/apply/setup sequence.
- `update` selects and stages one approved root commit, performs the
  fast-forward and setup without a stop, and may also
  replace Compose profiles.
- `setup` retries from the immutable repository selection already recorded by
  the workspace. For `setting-up`, `setup-error`, or recovery from `error`, it
  repeats root checkout and Project runtime manifest publication before
  Project setup and final ready publication, without fetching or resolving any
  repository ref.

**WORKSPACE-SELECTED-ROOT-PUBLICATION-001:** After preflight accepts a selected
root, DIM MUST atomically record its ref, commit, snapshot path, and a non-ready
workspace phase before mutating the checkout or Project runtime manifest. The
workspace MUST remain non-ready until both mutations complete and the final
ready record is durably published. Any checkout, manifest, or final ready-state
publication failure MUST leave a non-ready record bound to that selected root.
`run` MUST reject every non-ready phase. `setup` MUST recover using the recorded
root asset and complete `repositorySnapshot` by acquiring the Project lock and
then the workspace setup lock, revalidating the Project and workspace identity
under both locks, and repeating checkout and Project runtime manifest
publication before Project setup. It MUST NOT fetch or resolve any repository
ref during this recovery, even if a recorded ref has moved. `update` MUST
be able to select and publish a root again; only successful setup may return
the workspace to `ready`.

Dirty roots and non-fast-forward updates fail without modifying user work.
An otherwise clean local branch that is ahead of the reviewed root remains
compatible, matching `git merge --ff-only REVIEWED_COMMIT`; divergence means
neither commit is an ancestor of the other.
For a running workspace, `restart` MUST perform both checks while holding the
workspace setup lock and before stopping its container, changing its phase or
setup record, or interrupting Project services. A rejection MUST preserve the
checkout, workspace record, and running container identities and MUST name the
explicit `workspace align --reset --yes` recovery command. A successful
restart MAY apply the exact fetched commit accepted by this preflight so the
stop/start boundary does not repeat a mutable remote-ref decision.
Stop/start and restart preserve the checkout and named inner-engine volume.
Create may request plugin-provided workspace capabilities as `required` or
`recommended`. Provider registration names match request names exactly.
Missing or failed required capabilities abort creation; recommended ones are
recorded as unavailable and do not block setup. The workspace record and
Project runtime manifest expose the effective provider, status, and diagnostic
detail. DIM validates provider-returned container capabilities, security
options, devices, and environment entries before applying them.

## Cleanup

**WORKSPACE-DISCARD-VOLUMES-001:** `discard --yes` MUST invoke a custom
`.dim/teardown.sh` with `DIM_WORKSPACE_DISCARD_KEEP_VOLUME=0`. With
`--keep-volume`, DIM MUST pass `DIM_WORKSPACE_DISCARD_KEEP_VOLUME=1`. At `1`,
Project teardown MUST NOT delete nested named data that the Project intends to
survive recreation of the same workspace name. At `0`, Project teardown keeps
its ordinary cleanup authority. In both cases, external volumes remain
Project-owned and outside DIM cleanup.

DIM then removes the workspace container and record. The named inner-engine
volume is an outer DIM-managed volume that stores the workspace container's
nested engine. `--keep-volume` retains that volume so a later same-name create
can validate and reuse it; ordinary discard removes it. Nested named volumes
created inside that engine are Project-owned resources. Their retention at
`--keep-volume` depends on the teardown contract above and on retaining the
outer engine volume. Discard does not delete Project metadata or managed Git
repositories.

**PROJECT-DELETION-001:** `project remove` and `project purge --yes` MUST
acquire the Project lock and then the Project-scoped CI-runner lock. Both MUST
refuse while the Project is referenced. `project remove` MUST leave the
reserved Gitea organization in place. `project purge --yes` MUST delete each
DIM-managed Gitea repository before deleting that organization. Both commands
MUST remove protected root snapshots before deleting the final Project state.
If any required cleanup fails, the Project state MUST remain so a retry can
complete cleanup. A purge retry MUST treat an already-absent managed Gitea
repository or organization as successfully cleaned up.

## Verification

Required tests cover:

- atomic Project/repository/workspace claims and schema rejection;
- two Projects using the same repository alias without collision;
- empty creation, standard initial push, delayed protection, and import;
- host/workspace URL separation and credential-free output;
- root clone/ref validation and runtime manifest injection;
- no live update of a running workspace;
- start/restart fast-forward and dirty-root rejection;
- task/raw command dispatch, stop persistence, discard cleanup, and both
  teardown keep-volume values;
- Project deletion refusal while referenced, Project-to-CI-runner lock order,
  Gitea repository-to-organization cleanup order, protected-snapshot cleanup
  before Project state deletion, retained state after cleanup failure, and
  successful retry when managed Gitea resources are already absent;
- schema-`5` complete alias-keyed repository selection, including requested
  refs, resolved refs, and exact commits for the root and every other alias,
  ready-only entries, and literal root `HEAD` request preservation separately
  from its concrete protected branch;
- non-root workspace ref overrides from packed CLI transport through exact
  resolution, persisted state, and runtime-manifest publication, including
  rejection of malformed, root, unknown, and duplicate overrides without
  Project-state mutation;
- complete workspace container and volume ownership labels and identity
  digests, inspected-ID-only container mutations, post-create inspection,
  volume reinspection before removal, and same-name replacement races;
- refusal to delete the selected importing repository before provider or state
  mutation, without blocking deletion of a ready target whose sibling imports;
- protected-root commit pinning, atomic full-tree snapshot publication,
  separate `rootSnapshotPath` retention, read-only outer mounting, mutable-file
  substitution resistance, missing snapshot rejection, and retry/discard
  provenance pinning;
- selected-root metadata publication before checkout or manifest mutation,
  non-ready state and `run` rejection after fault-injected checkout, manifest,
  and final ready-state write failures, plus recovery through `setup` and
  `update`;
- packed CLI help, JSON output, URL stdout, and Git credential wrapper.
