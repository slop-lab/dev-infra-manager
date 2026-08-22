# Project, Repository, and Workspace Lifecycle

## State and identities

DIM stores schema-versioned Project and workspace records below
`DIM_STATE_ROOT`, defaulting to `~/.local/state/dim`.

```text
<stateRoot>/projects/<project>.json
<stateRoot>/workspaces/<workspace>.json
<stateRoot>/services/gitea.json
<stateRoot>/locks/project-<project>.lock
<stateRoot>/locks/workspace-<workspace>.lock
```

Project and workspace records use persistent IDs distinct from display names.
Incompatible pre-stable schemas are rejected without mutation unless a
release explicitly defines a migration.

## Project namespace

The built-in managed Git service is one DIM-owned Gitea instance. Each Project
owns the reserved organization `dim-<project>` and repository aliases are
scoped below it:

```text
dim-acme/root
dim-acme/product
dim-acme/environment
```

Project metadata contains its name/ID, namespace, repository catalog, and
exactly one root repository/ref when runnable. Infrastructure implementation
belongs to the root repository, not the Project state.

Claims precede Gitea mutations. Project and repository reconciliation is
serialized, records errors for diagnosis, and rejects unmanaged identity
collisions.

## Repository creation and import

Empty repository creation is the primary operation. It returns separate host
and workspace endpoints without credentials. Users may populate it with any
standard Git commands.

Protection is pending until the initial push, then applied explicitly or when
the root is first used to create a workspace. The default CLI import transfers
branches and tags before applying protection; `--mirror` explicitly includes
all source refs.

External sources are accessed only through the local Git CLI and its existing
credential configuration. DIM does not provision external Git providers or
proxy Git traffic. A repository retains its explicit external connection so
`repo fetch` can project remote branches under managed `upstream/*` and
`repo push` can publish explicitly named, non-forced branch or tag refspecs.

## Root workspace contract

A workspace binds permanently to a Project ID and directly clones only the
configured root repository/ref at:

```text
/workspace/project
```

Creation records an immutable effective KVM capability. When host `/dev/kvm`
is readable and writable and the selected backend supports it, DIM passes the
device directly into the trusted workspace container. For non-privileged
rootless-Podman workspaces it also adds the device's host GID as a supplemental
group. gVisor workspaces record KVM as unavailable. DIM does not place the
workspace container in a VM.

The root repository owns the optional:

```text
.dim/setup.sh
.dim/entrypoint.sh
.dim/teardown.sh
.dim/docker-compose.yml
.dim/repos.yml
```

It also owns checkout and reconciliation of any additional Project
repositories. DIM supplies a read-only runtime manifest and environment to
`.dim/setup.sh`, `.dim/entrypoint.sh`, `.dim/teardown.sh`, and `exec`:

The optional `.dim/repos.yml` is a repository-connection set, not a Project or
workspace manifest. Its `repositories` mapping keys are stable Project-scoped
aliases, including the single root alias used by lifecycle code and agents.
Registering a root may offer to apply this file, but
non-interactive use must opt in explicitly. Applying it never removes a
managed repository omitted from the file. A standalone `repos.yml` with
exactly one `root: true` may be passed to `project create --repos`.
The normal bootstrap uses `project create --url URL` to read `.dim/repos.yml`
from the selected external ref before creating Project state. The manifest's
single `root: true` mapping key fixes the root alias. The command can then
apply, skip, or interactively offer that set without a local clone. A skipped
set remains available through `repo plan` and `repo apply` with no `--file`.
Manifest-free repositories use the explicit `--root ALIAS --url URL` form.

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

The read-only runtime manifest also contains `hostAliases`, a mapping from
workspace-visible service names to one or more controller-resolved addresses.
DIM registers only endpoints granted to that workspace; Project lifecycle
code selects which nested services receive them. The canonical self-Project
generates a Compose override that applies the mapping to its agent service.
This is a static bootstrap registry: address changes take effect when setup
reconciles the workspace and recreates the affected Project service.

The Project manifest retains schema version `1` and publishes the workspace
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
```

Agent containers are ordinary, reviewed Project workloads. A Project may
declare one in `.dim/docker-compose.yml`, start it from `.dim/setup.sh`, and
dispatch fixed tasks into it from `.dim/entrypoint.sh`. Core owns none of its
image, service, volume, privilege, or task configuration. `dim workspace run WORKSPACE
TASK` always follows the checked-in `.dim/entrypoint.sh` contract when present.
The canonical self-Project exposes `codex`, an agent-container `bash` task,
and Project-owned `backup`/`restore` tasks that stream a gzip tar archive of
the agent home over stdout/stdin. Those canonical tasks temporarily stop the
agent and mount only its named home volume into a networkless archive
container, read-only for backup and read-write for restore. DIM does not
interpret or persist the archive.
Repository commands, including just recipes, run explicitly through the bash
task rather than growing one entrypoint task per recipe.

Before `create`, `start`, `setup`, or `update` runs Project setup, DIM must
ensure both managed controller APIs are healthy. The host-admin API listens on
a mode-`0600` state-root-specific Unix socket which never enters a workspace.
The workspace API listens on a separate Unix socket directory mounted at
`/run/dim/controller` in the trusted workspace root. Mounting the directory,
rather than the socket inode alone, keeps existing workspace mounts valid when
the controller restarts. Nested Project services do not inherit the mount or
grant.

`POST /api/workspace/restart` accepts no body, derives the target exclusively
from the authenticated workspace grant, returns `202` before lifecycle work
begins, and asynchronously performs the ordinary stop, root fast-forward, and
setup sequence. A caller cannot name or restart another workspace.

The standard workspace image provides `dim-controller-proxy`. Reviewed root
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

Plugins register host administration routes separately from workspace routes.
Administration routes run only on the host-admin socket. A workspace route is
reachable only with a workspace grant and may be narrowed further by reviewed
Project-root proxy policy; registering an admin route never exposes it through
that proxy.

`DIM_GIT_BASE_URL` is Project-specific. Project lifecycle code appends its
own stable managed repository names and owns all checkout paths and
repository-to-service mappings. DIM does not export per-repository
variables. `COMPOSE_PROJECT_NAME`, `containerName`, and `dockerVolumeName`
are the only stable identifiers for Docker resources DIM creates for a
workspace; callers must read them from `dim workspace show WORKSPACE --json` rather
than reconstructing a naming scheme, which is not part of this contract and
may change.

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

The canonical self-Project stores the unprivileged agent's home in a
Project-owned named volume and sets `HOME=/home/dim-agent` for setup and task
dispatch. Agent configuration persists across task processes and service
recreation, while workspace discard removes the volume through reviewed
teardown.

## Applying changes

DIM never applies Project or root remote changes to a running workspace
automatically.

- `start` starts a stopped runtime, fetches the configured root ref,
  fast-forward merges it, and runs setup. The built-in Compose fallback MUST
  force-recreate services because stopping the outer workspace also terminates
  their runtime processes; Project-owned setup remains responsible for its own
  equivalent reconciliation.
- `restart` stops a running runtime and performs the same start/apply/setup
  sequence.
- `update` performs the fast-forward and setup without a stop and may also
  replace Compose profiles.
- `setup` retries setup without fetching.

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

## Cleanup

`discard --yes` attempts root teardown and removes only the workspace
container, named inner-engine volume, and workspace record. It does not delete
Project metadata or managed Git repositories.

`project remove` refuses while referenced and otherwise removes metadata only;
the reserved Gitea organization remains. `project purge --yes` refuses while
referenced and otherwise deletes the DIM-managed organization and Project
metadata.

## Verification

Required tests cover:

- atomic Project/repository/workspace claims and schema rejection;
- two Projects using the same repository alias without collision;
- empty creation, standard initial push, delayed protection, and import;
- host/workspace URL separation and credential-free output;
- root clone/ref validation and runtime manifest injection;
- no live update of a running workspace;
- start/restart fast-forward and dirty-root rejection;
- task/raw command dispatch, stop persistence, and discard cleanup;
- packed CLI help, JSON output, URL stdout, and Git credential wrapper.
