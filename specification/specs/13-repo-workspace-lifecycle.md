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

Workspace IDs are authority identities under `WORKSPACE-AUTHORITY-001` in
[Trust and Lifecycle Capability Matrix](04-trust-lifecycle-capability-matrix.md).
Stop, start, restart, setup, and update retain that ID. Discard ends it, and
same-name recreation MUST issue a fresh ID; retained data and deterministic
resource names MUST NOT authorize the new instance.

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
not infer runner restart authority from current runner state.

The only supported historical state migration is host lifecycle schema `1` to
schema `2`. Schema `1` MUST have the same exact fields and validation as schema
`2`, except that it has `resumeCiRunners` instead of `restartCiRunners` and its
`schemaVersion` is `1`. Migration changes only those two values. Every other
schema, malformed value, missing or extra key, and invalid nested target MUST
be rejected without mutation. Normal runtime parsing remains schema-`2`-only;
the migration is a controller-startup operation and MUST NOT apply to Project,
workspace, runner, plugin, installer, or other state.

Migration MUST acquire the non-reentrant host lifecycle lock once, then reread
all artifacts under that lock. `host.json`, the fixed permanent
`host.json.schema-1.bak`, and recognized same-directory migration temporaries
MUST be inspected with `lstat`; symlinks and non-regular files are ambiguous and
MUST fail closed. The backup MUST contain the byte-exact original schema `1`
record at mode `0600`, MUST be published without replacing an existing path,
and MUST never be deleted. It is immutable historical recovery material, not
a live mirror of later schema-`2` lifecycle state. Backup and replacement
temporaries use unique `host.json.schema-{1,2}...tmp-<pid>-<randomUUID>` names,
exclusive creation at mode `0600`, file sync before publication, and
parent-directory sync after each namespace change. Canonical publication uses
atomic rename and the resulting record MUST parse as strict schema `2` before
migration succeeds.

Valid schema `1` with no backup migrates after creating the backup; valid schema
`1` with a byte-identical backup completes migration; valid schema `2` with no
backup or with any valid historical schema `1` backup is authoritative and
unchanged, without comparing its lifecycle contents to the backup; and an absent
canonical record with a valid schema `1` backup is recovered as schema `2`.
Normal schema-`2` lifecycle writes MUST leave the backup byte-identical.
Recognized regular orphan temporaries are removed only after canonical and
backup validation. An existing backup that differs from a canonical schema `1`
record, and every malformed or unsafe combination, fail without canonical
mutation. Repeated and concurrent calls MUST converge, readers MUST observe
complete old or new canonical bytes, and every failure MUST release the
lifecycle lock so a later retry can finish.
An absent canonical record with no backup is the valid fresh-host state and is
left unchanged.

## Project namespace

The built-in managed Git service is one DIM-owned Gitea instance. An explicitly
configured external Gitea service is operator-owned and shared independently
of each host's unchanged DIM controller. In both modes each Project owns the
reserved organization `dim-<project>` and repository aliases are scoped below
it:

```text
dim-acme/root
dim-acme/product
dim-acme/environment
```

Project metadata contains its name/ID, namespace, trusted Gitea organization
ID, repository catalog, and exactly one root repository/ref when runnable.
Infrastructure implementation belongs to the root repository, not the Project
state.

Repository fetch and publish require a separately deployed narrow
synchronization service on the physical Git host in both managed and external
Gitea topologies. DIM controllers remain on their existing hosts and receive no
filesystem or generic command route to that server. The service's private
registry binds Project IDs and aliases to actual Gitea bare repositories; the
caller supplies no managed path. A direct upstream fetch may write only the
service-owned hidden namespace. Every visible managed ref update returns
through Gitea receive-pack, and outbound publication remains selective and
non-forced.

Claims precede Gitea mutations in managed mode. External mode validates its
private connection and explicit shared Project binding before local claims or
remote mutations. Project and repository reconciliation is serialized,
records errors for diagnosis, and rejects unmanaged identity collisions.
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

For a reviewed root branch, protection MUST reject ordinary direct pushes and
force pushes while requiring an approval by a designated human reviewer for
every pull request. The host-only maintainer remains the explicit recovery and
publication identity, but protected publication MUST pass
`TRUST-PROMOTION-001` and `TRUST-PROMOTION-CAS-001`; it is not a review-bypass
authority. Repository owners are not direct-push exceptions;
administrators MUST NOT bypass pull-request reviews in routine merges. Neither
protected-file patterns, which also reject reviewed merges, nor unprotected-file
patterns, whose path classification is insufficient for rename-safe exceptions,
may be used to simulate selective path review. Projects may add CODEOWNERS for
paths such as `.dim/**`, with any missing or newly introduced paths still
requiring the general pull-request approval.

Deleting a repository MUST reject the selected target while its phase is
`importing`, before any Gitea or Project-state mutation. An importing sibling
MUST NOT block deletion of a different `ready` target.

External sources are accessed only through the local Git CLI and its existing
credential configuration. DIM does not provision external Git providers or
proxy Git traffic. A repository retains its explicit external connection so
`repo fetch` can project remote branches under managed `upstream/*` and
`repo publish` can publish only configured, non-forced branch mappings.
Omitting the repository alias publishes every repository with configured
mappings. DIM's self Project maps 11 managed `main` heads to 11 independent
GitLab development upstreams on `main`. `dim repo publish dim` publishes only
to those GitLab upstreams. Integrated canonical publication and release on
GitHub remain separate trusted maintainer actions outside that command's
authority.

An existing ready root origin is not replaced by an ordinary repository-set
apply. An explicit, reviewed root-origin rebind MAY change only the recorded
external URL when the alias, selected protected ref, namespace mapping,
publication policy, and protection policy are unchanged. The new origin MUST
advertise an operator-supplied complete commit ID and include the current
managed root tip in its ancestry. DIM MUST recheck both tips and the recorded
old origin under the Project lock before publishing that connection update.
This changes no managed ref or workspace snapshot and does not remove aliases
omitted from the new repository set. Retirement of old repositories and
workspaces remains an explicit maintenance action after review and verification.

## Root workspace contract

A workspace binds permanently to a Project ID. DIM mounts the selected root
contract read-only at:

```text
/run/dim/project-root
```

Persistent Project-owned data is mounted at `/var/lib/dim/workspace-data`.
DIM never clones, fetches, switches, merges, or resets a repository there.
For create, start, update, and restart, DIM resolves a
single concrete branch covered by the root repository's applied protection,
pins its exact commit, and atomically publishes the complete commit tree below
the controller-owned content-addressed assets path. The workspace record uses
schema version `8` and records a fresh 256-bit workspace instance ID together
with that root ref, commit, and the canonical workspace-data path. The
protected-root path is derived from the state root,
Project ID, and exact commit rather than persisted. The record contains no repository catalog or
per-repository ref overrides. Schema `7`, older workspace schemas, and records containing
obsolete checkout-layout fields are rejected before mutation, with guidance
to use the prior pinned release to export important Project/user data and then
discard and recreate the workspace. No workspace-state migration is defined.

The selected Project-root snapshot is mounted read-only only into the trusted
outer workspace. It is not writable agent data. Setup, entrypoint,
teardown, Compose fallback, and relative helpers or build contexts execute from
that snapshot. `DIM_PROJECT_ROOT` names the immutable root and
`DIM_WORKSPACE_DATA` names persistent Project-owned data. Reserved lifecycle files must not be
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
`--bootstrap-git-ref components/root` with `ref: main` and
`import: {main: components/root}` imports only that external branch as managed
`main`; subsequent root-manifest reads use managed `main`.

```text
DIM_PROJECT_ID
DIM_PROJECT_NAME
DIM_PROJECT_ROOT
DIM_PROJECT_MANIFEST
DIM_WORKSPACE_DATA
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

The runtime manifest uses schema version `3`. It records only the immutable
root identity and path, the persistent data path, the Project-specific managed
Git base URL, host aliases, and generic runtime capabilities. Project code owns
repository aliases, refs, checkout paths, retries, and integrated development
layout. It may use the managed Git base URL to materialize repositories, but
must not infer a DIM-owned repository catalog from the runtime manifest.

The manifest publishes the workspace
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
Top-level `dim run` is the same Project task boundary. Top-level `dim exec`
and `dim workspace exec` bypass the entrypoint and provide raw access to the
trusted workspace container; they are recovery and lifecycle-administration
paths, not agent entrypoints.

**WORKSPACE-AGENT-SETUP-001:** Coding-agent tool installation MUST be an
explicit workspace-user action inside a Project-owned agent. DIM and trusted
`.dim/setup.sh` lifecycle code MUST NOT perform it automatically. A Project may
publish a user-run bootstrap script, but invoking that script MUST happen
through a Project task such as the conventional
`dim run WORKSPACE tool-setup` or from an interactive `bash` task. The script
MAY mutate only the invoking user's home,
including user-local executables and agent configuration. It MUST NOT perform
authentication, change global Git configuration, expose a web interface,
request DIM controller or plugin authority, or modify the trusted workspace.
This is a Project convention and introduces no DIM plugin, API, lifecycle
hook, or CLI command.

**WORKSPACE-AGENT-TASK-001:** A Project MAY expose the generic task names
`tool-setup` and `agent`. DIM core MUST NOT assign tool semantics, installation
paths, a registry, options, or automatic lifecycle behavior to those names.
The reviewed Project entrypoint MUST explicitly map setup to reviewed utility
bytes and agent launch to a supported contract version, launcher name, pinned
tool identity and version, and exact executable path. A compatible setup
utility MAY publish a mode-restricted manifest and launcher below canonical
user `HOME`. Before execution, the Project-owned launcher MUST reject a
missing or non-regular manifest, unsupported contract version, unknown
launcher, mismatched tool identity or version, mismatched executable path,
canonical target outside `HOME`, and non-file or non-executable targets. Setup
and launch MUST remain separate explicit actions. Neither may
perform provider login, and `.dim/setup.sh` MUST invoke neither.

**WORKSPACE-AGENT-WEB-001:** A Project MAY publish a Web launcher separately
from the setup script. Launch MUST be an explicit workspace-user action and
MUST fail when the pinned OpenCode prerequisite or development-service
socket is absent. A non-empty Basic Auth credential MUST be configured before
the listener binds to loopback. Persistent credentials, logs, lock state,
and process identity MUST remain in mode-restricted state below canonical
`HOME`; credentials MUST NOT appear in command arguments, URLs, logs, or
repository files, and the launcher MUST NOT print the password in routine
output. It MUST report the restricted credential-file path so the user can
explicitly read its two-line username/password content. The launcher MUST use
`dim-development-service expose` with a stable service name, the selected local
port, ingress, and HTTPS requirement. Its DIM integration MUST depend only on
`DIM_DEVELOPMENT_URL_SOCKET`, with no target/container metadata and no fallback
to the generic external URL capability. The trusted proxy MUST inject an exact
container path, HTTP protocol, and shared gateway port after authorizing the
ingress-only request. Trusted nested routing MUST map the queried gateway port
to the same container port (`G:G`) where publication is required. The gateway
MAY listen on the agent container's interfaces at that port, but MUST forward
application traffic only to `127.0.0.1:PORT`. The launcher MUST establish
readiness through a bounded authenticated health request and prove through the
Linux listening socket that the exact newly started or recorded process owns
the configured port. Lock,
the complete helper process tree, readiness, and cleanup waits MUST be bounded.
It MUST NOT adopt or kill
an unrecorded process, even when that process accepts the same credentials. URL
reuse is keyed by stable service name and ingress; changing the local port MUST
update only that service's shared-gateway route while retaining the URL and URL
ID. The launcher MUST NOT stop the shared gateway on retry or failure. This
capability MUST provide only the restricted socket, not a controller grant,
raw host secret, target metadata, or new lifecycle authority. Other separately
reviewed agent capabilities remain independent. Access to this socket permits any
same-agent process to expose a service reachable through the agent's existing
network authority and MUST NOT be described as intra-agent isolation.
The launcher MUST always supply `https://localhost:4096` as an exact CORS
origin. It MUST accept `OPENCODE_WEB_CORS_ORIGINS` only as a JSON array of
additional exact HTTP or HTTPS origins, defaulting to `[]`, where each origin
identifies the requesting browser UI rather than the destination external URL. Before it
creates credentials, logs, lock state, or process state, it MUST reject invalid
JSON and values containing a wildcard, user information, path, query, or
fragment. It MUST normalize URL origins, deduplicate and sort the complete
list, and pass each origin to OpenCode separately. The pinned OpenCode release
does not support `*` as a wildcard, so the launcher MUST reject it. OpenCode MAY
also merge origins from its existing server configuration or built-in
behavior; the launcher MUST NOT describe its inputs as a universal deny list.

OpenCode CORS headers MUST remain effective through the external URL route.
Preflight responses MUST allow the `Authorization` and `Content-Type` headers
needed by browser clients, while application requests MUST remain protected by
Basic Auth. The browser client MUST send the reported credential in the
`Authorization` header. A launcher retry MAY reuse its healthy owned process
only when both the port and canonical CORS list match. A change to either MUST
restart only the recorded owned process while retaining its credential, stable
external URL, and shared gateway. Projects SHOULD allow only trusted browser
UI origins.

The script MUST resolve `HOME` to its canonical path and reject every mutation
target whose canonical path is not contained beneath it. For a target that
does not yet exist, containment validation MUST account for its nearest
existing parent and any symbolic links. The canonical install prefix is
`$HOME/.local`. The npm install prefix, cache, and user configuration file MUST
all resolve to canonical descendants of `HOME`; inherited npm environment or
configuration MUST NOT redirect those mutation roots. The effective cache home
`${XDG_CACHE_HOME:-$HOME/.cache}` MUST be exported as a canonical descendant of
`HOME`; a value or symbolic-link target that resolves outside `HOME` MUST be
rejected before npm runs. The effective data and state homes MUST default to
`${XDG_DATA_HOME:-$HOME/.local/share}` and
`${XDG_STATE_HOME:-$HOME/.local/state}`. Their values MUST be absolute and
newline-free, resolve to canonical descendants of `HOME`, and be exported in
canonical form before npm runs. Relative or newline-containing values, and
values or symbolic-link targets that resolve outside canonical `HOME`, MUST be
rejected before npm runs. These XDG homes remain separate from the dedicated npm
cache and user configuration. OpenCode configuration remains in the
home-confined XDG directory `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`; an
`XDG_CONFIG_HOME` that resolves outside `HOME` MUST be rejected. An existing
symbolic link at
`$XDG_CACHE_HOME/opencode/packages/oh-my-openagent@4.19.4` MUST be rejected
regardless of its target, and preflight validation MUST NOT create that
coordinate. OMO 4.19.4 configuration uses exactly `$HOME/.omo/omo.jsonc`, with
the bounded Team Mode settings at `["[opencode]"].team_mode`.

Configuration updates MUST use targeted, comment-preserving JSONC edits. They
MUST preserve unrelated properties, comments, and existing plugin options;
whole-document parse and reserialization is not acceptable. Setup invocations
for the same home MUST use flock-equivalent exclusive lock semantics covering
package mutation, configuration mutation, and final installed-version
verification, so concurrent runs cannot overwrite each other's edits. Lock
ownership MUST be released on every exit, and a failed or interrupted holder
MUST NOT permanently block a retry. Each configuration-file replacement MUST
avoid exposing a partial file, and an interrupted or partial multi-file run
MUST converge to the required state when retried. The bootstrap is not required
to make package installation and all configuration files one transaction.

When a Project documents a remote bootstrap, both the script and its
`.sha256` file MUST be fetched from the same full, immutable development
commit. The commit input MUST match exactly 40 lowercase hexadecimal
characters. The copyable download procedure MUST run in a fail-closed
`set -euo pipefail` subshell, derive both URLs from that same validated commit,
verify the checksum before streaming the local bytes to a reviewed
stdin-consuming Project task, and remove temporary files through an exit trap.
A branch, tag, `latest` URL, or direct download-to-shell pipeline is not an
acceptable bootstrap source. The canonical self-development Project instead
maps `tool-setup` to the reviewed local script at
`/workspace/scripts/workspace-user-setup.bash`; its remote bootstrap MUST
stream verified bytes through its existing `bash -- -s` task rather than
`tool-setup`. Existing homes MUST NOT be upgraded automatically; the user must
explicitly rerun the applicable setup action after adopting a reviewed setup
or version change.
Complete Project examples MUST accept an operator-supplied, provider-neutral
raw-source root ending before the commit segment, normalize one optional
trailing slash, and combine that root with the validated commit. They MUST NOT
hard-code a provider raw-content hostname. The root README MAY use DIM's
canonical GitHub raw source.
The canonical self-Project's default outer Compose graph contains only a
private rootless `agent-dind` daemon; its optional secure profile adds only a
separate `secure-dind`. Its agent daemon user adopts the numeric UID/GID that
owns the workspace checkout. That daemon owns the agent and ordinary
development containers, and the agent receives only its private daemon socket.
Rebuilding or replacing those inner workloads therefore requires no trusted
workspace or host runtime socket. The agent may run as UID 0 inside the
rootless daemon's user namespace: that UID maps to the non-root daemon UID
which owns the checkout, rather than to root in the trusted workspace or on
the host.
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
the `dim-agent` account. Project setup that publishes this task as ready MUST
wait for the agent service's SSH listener through a bounded health check; a
started container whose SSH listener is not accepting connections is not ready.

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

**WORKSPACE-PRIVATE-RUNTIMES-001:** DIM MUST NOT require a fixed count of
Project-owned nested daemons. A reviewed Project MAY use zero daemons when it
needs no nested container runtime, one private daemon for agent-controlled
development workloads, or separate agent and secure daemons when it combines
agent Docker authority with secret-bearing workloads. The complete rich
examples and canonical self-Project use the separate-daemon shape as practical
guidance, not as a universal two-DinD mandate.

When a Project uses that separate-daemon shape, secret-bearing workloads MUST
use `secure-dind` storage distinct from `agent-dind`. The agent daemon socket,
agent home, workspace source, and workspace Git credentials MUST NOT be mounted
into the secure daemon. The secure daemon socket and raw secret MUST NOT enter
the agent. Any communication exposed to the agent MUST be a fixed,
Project-reviewed application protocol endpoint rather than a Docker control
endpoint. Neither daemon may receive a host or trusted-workspace runtime
socket.
Each private daemon MUST listen only on its dedicated Unix socket. Project
entrypoints using an upstream DinD image MUST pass an explicit `dockerd`
command and Unix `--host`; they MUST NOT rely on the image's empty-argument
defaults, enable a Docker TCP listener, or configure RootlessKit to forward
ports 2375 or 2376. A reviewed application relay MUST NOT make either daemon's
control API reachable from the other authority.
An agent-home volume entering a rootless private daemon MUST be initialized
only when its root is empty. Initialization MUST assign the top-level root to
the mapped inner agent identity with owner-only access. A populated root
with incompatible ownership or mode MUST fail setup without recursively
rewriting descendants. Inner agent startup may assign that top-level directory
to its established task or SSH identity, but MUST preserve existing descendant
ownership and modes.
Trusted operations that build or deploy a secret-bearing workload MUST execute
their script and Compose definition from the immutable selected root. They MUST
NOT resolve those authority-bearing bytes relative to the mutable Project data
checkout, although mutable checkout files may remain ordinary agent work.
The canonical self-Project exposes an agent-container `bash` task and
Project-owned `backup`/`restore` tasks that stream a gzip tar archive of
the agent home over stdout/stdin. Those canonical tasks temporarily stop the
agent and mount only its named home volume into a networkless archive
container, read-only for backup and read-write for restore. DIM does not
interpret or persist the archive.
Repository commands, including just recipes, run explicitly through the bash
task rather than growing one entrypoint task per recipe.

**WORKSPACE-QEMU-INPUT-001:** The canonical self-Project's constrained QEMU
service MUST claim a run synchronously before awaiting its request body or any
filesystem operation. It MUST reject a new run while another run owns the
service, and it MUST reject duplicate input names before filesystem validation.
Each admitted run MUST own a fresh set of service-owned input snapshots that
the agent cannot mutate after admission.

Core MUST dispatch Project setup and teardown as `dim` from the immutable
`/run/dim/project-roots/<commit>` snapshot. Only QEMU namespace, owner,
launcher, service, and reset operations elevate through the existing sudo
boundary. Every elevated Node invocation MUST use the fixed
`/usr/bin/node`. The elevated command MUST begin with `/usr/bin/env -i` and an
explicit `PATH` and `HOME` before invoking either root Node or `/bin/sh`, so
unrelated inherited environment variables never reach root QEMU commands.
Snapshot copying MUST NOT dereference symlinks. It MUST anchor traversal to
open descriptors, enumerate directories as a stream from open directory
handles, stream regular files with bounded memory, preserve regular file
permission bits, and reject sockets, FIFOs, devices, and every other
unsupported entry type. The fixed launcher and its child process MUST receive
only the immutable snapshot paths, never the live input paths. If validation
or any snapshot operation fails, admission MUST fail, the run MUST own no
reusable partial snapshot, and no launcher or other child process may start.

The service MUST represent its process identity with a mode-`0600`, schema-1
`service-owner.json` record. The record MUST remain unchanged and have exactly `schema`, `pid`,
`startTicks`, `argv`, `executable`, `cwd`, and `socket`. `pid` and
`startTicks`, each `device` and `inode`, and every other identity value whose
precision can exceed JSON's exact integer range MUST remain canonical decimal
strings. The PID MUST be positive and no greater than either the kernel's
`pid_max` or JavaScript's maximum safe integer. `startTicks` and each inode
MUST be positive. `argv` MUST be a nonempty array of strings. `executable` and
`cwd` MUST each contain exactly a canonical absolute `path`, `device`, and
`inode`; `socket` MUST contain exactly `device` and `inode`.
Service inspection output MUST have only the exact `state`, `pid`,
`startTicks`, `owner`, and `socket` identity fields. Exact retirement MUST
compare the immutable PID, process-start ticks, owner identity, and socket
identity captured by inspection. A process becoming dead after inspection is
an allowed live-to-dead transition and does not invalidate those immutable
identity comparisons.

The service MUST pin the owned socket inode with a non-replacing hard link at:

```javascript
resolve(dirname(socketPath), `.${basename(socketPath)}.lease`)
```

It MUST create and directory-sync this hidden lease immediately after bind and
socket identity capture, before socket chmod or owner publication. It MUST
chmod through the lease. A pre-existing lease path is a collision: startup
MUST preserve it and fail closed rather than remove, replace, or adopt it.

Ownership inspection MUST match the record against the exact PID, process
start ticks, complete argument vector, executable path and file identity,
working-directory path and file identity, expected service working directory,
and socket type and identity. The owner file, public socket, and lease MUST all
exist, and the public socket and lease MUST have the recorded device and inode,
for state to be owned. Absence of all three is the only unowned state. Partial,
malformed, foreign, identity-mismatched, or replaced state MUST fail closed
without signalling a process or removing an artifact. An obsolete
`service.pid` MUST be rejected with no migration path, whether its named
process is live or dead.

The lifecycle MUST execute the owner and service scripts by absolute path from
the immutable Project-root snapshot. The service process MUST change to the
stable `/tmp/dim-qemu-verification` directory before execution, and that path
and identity MUST be recorded as its owner working directory. This service
working directory is distinct from `DIM_QEMU_SOURCE_ROOT`: admitted launchers
MUST receive `/workspace` as their source root and process working directory.
The fixed launcher copied from the immutable Project-root snapshot into the
root-owned service namespace does not change that source-root boundary.

In the supported lifecycle, workspace creation, setup, and discard serialize
through the workspace setup lock before Project setup can create or replace the
QEMU service namespace. Project setup MUST create the service directory before
service start; the service MUST require that pre-existing path to be a
non-symlink root:root directory with mode exactly `0755`, including no special
mode bits, and both agent mount layers MUST expose it read-only. Startup MUST reject any existing or symlink `service.pid`, owner,
public socket, or lease path, while stale run state is allowed until activation.
Enabled setup, disabled setup, and teardown MUST each reject any regular-file
or symlink `service.pid` before signalling a process, retiring ownership, or
removing an artifact; obsolete PID state has no compatibility path.
It MUST prepare a fresh adjacent root:root directory with mode exactly `0700`,
including no special mode bits, before binding. The service starts in
`starting`, and every route, including status and run, MUST return `503` until
both owner publication and prepared-runs activation commit complete. It may
then enter `accepting`.

Activation MUST first rename stale canonical runs aside to a unique
`runs.replaced-*` quarantine path, then rename prepared runs to the canonical
path. Failure before the prepared-to-canonical rename commits MUST restore the
exact stale canonical state and discard only the prepared directory. The
prepared-to-canonical rename is the activation commit. Failure of recursive
cleanup after that commit is fatal: the fresh canonical runs MUST remain,
every old remainder MUST stay quarantined under `runs.replaced-*`, and cleanup
MUST NOT falsely restore partial stale evidence as canonical.

Ownership inspection MUST open the owner pathname once without following
symlinks and obtain its identity and bytes from that descriptor. Owner
publication MUST derive identity from its temporary file descriptor and
preserve a replacement at the temporary pathname during cleanup. It MUST
create and sync a fresh temporary file, publish it
without replacing an existing path, sync the containing directory, remove the
temporary file, and close its handle. Publication is transactional across the
post-link directory sync, temporary cleanup, and close stages. Failure at any
stage MUST aggregate errors in stable operation order and roll back only the
exact linked owner identity. Replacements and collisions MUST remain untouched,
and any quarantine evidence MUST be preserved. A publication collision or
later startup failure MUST leave an existing owner untouched and roll back only
the new instance's exact artifacts.

The server MUST treat a listen error as initialization failure and roll back
only state prepared by that startup. After listen succeeds, initialization
MUST install a temporary error handler that latches a server error.
Initialization MUST capture the bound socket identity and establish its
identity-pinned lease before honoring a latched error, so rollback can close
the listener safely. It MUST check for a latched error after each remaining
asynchronous initialization stage. Only after owner publication and run-root
activation commit succeed may it replace the temporary handler with the
permanent runtime error handler and enter `accepting`.

Cleanup MUST validate the lease against the captured socket identity
before safe close and again immediately before removing the lease. It MUST
operate sequentially, remove the lease last, and preserve a foreign public
socket that was safeguarded and restored. Shutdown MUST validate the lease
before close, stop admission, initiate server close, call
`closeAllConnections`, await close, and only then clean run and ownership state.
Incomplete raw HTTP headers MUST not block shutdown. Missing or mismatched
lease state MUST fail closed before server close; the server is unreferenced
rather than explicitly closed and ownership artifacts are not removed. When
closing a server could unlink a socket path that another instance replaced, the supported
serialized cleanup MUST hard-link the observed replacement to a fresh protected
path before removing the public pathname. After closing the old server,
restoration MUST hard-link the protected socket back to the socket pathname
without replacing an existing destination, then remove the protected path only
if it still has the captured identity. Failure to safeguard or restore the
observed replacement MUST preserve the protected artifact and fail closed.
This mechanism does not claim defense against arbitrary same-UID or root
pathname rebinding outside the supported serialized lifecycle.

Project setup MAY retire a live service only after exact ownership inspection.
It MAY remove dead residue only when the record and socket still match their
captured identities. Retirement and startup readiness MUST be bounded. Setup
MUST derive the launched PID from the structured owner record and publish
readiness only after that process has root UID, the owner has exact mode
`0600`, the public socket and lease each have exact mode `0666`, and a bounded
status request succeeds. If a started wrapper never publishes ownership, setup
MUST fail after the readiness bound without signalling that unowned wrapper.
Readiness failure after valid publication MUST retire only that exact owner;
replacement during readiness MUST remain untouched. A KVM-disabled setup MUST
still perform the root-owned reset through the same constrained elevated
boundary.

Service shutdown MUST stop admission before aborting an in-progress request or
snapshot. Cancellation and shutdown MUST signal the launcher's detached
process group with TERM, wait for a bounded grace period, escalate the same
group to KILL if it remains live, and await child closure before run cleanup.
An asynchronous launcher spawn failure MUST finalize the run, release
admission, and remove its snapshot. The complete process group MUST disappear
before snapshot deletion. If any member remains after KILL, the service MUST
stop admission, close its listener after validating the owned lease, restore
the owned public socket only when that pathname was not replaced, and preserve
and restore a safeguarded foreign public replacement when one was present. It
MUST exit nonzero and preserve owner, lease, run, and snapshot evidence.
Shutdown MUST await run completion and snapshot cleanup
before removing the run tree and its own owner, socket, and lease artifacts. A
snapshot cleanup failure is fatal: the service MUST stop admission without
releasing the active-run claim, preserve the owner, socket, lease, run tree,
and exact snapshot evidence, start no later launcher, and exit nonzero. The
permanent runtime error handler MUST stop admission, terminate any active
detached process group with the same bounded TERM-to-KILL protocol, validate
the lease and safeguard a foreign public replacement before closing the
listener, preserve ownership and run evidence, and exit nonzero. Every caller
that observes finalization rejection MUST enter this fatal shutdown path rather
than translating the failure into an ordinary request error.

Run cleanup ownership MUST linearize before snapshot removal begins. If fatal
shutdown owns cleanup first, snapshot removal MUST NOT start and the exact
snapshot MUST remain as evidence. If ordinary cleanup owns first, it MUST
finish the already-committed removal; a later fatal upgrade MUST await it,
retain the active-run claim and every remaining service and run artifact, and
MUST NOT claim that the snapshot whose deletion already began remains intact.

Shutdown ownership MUST be serialized. The first graceful signal owns and
continues ordinary cleanup; a runtime error received while that cleanup is in
progress MUST reuse the graceful shutdown promise and upgrade the final exit to
`1` without starting competing run or listener cleanup. If fatal shutdown owns
the transition first, it MUST preserve evidence, and later signals or runtime
errors MUST reuse that same fatal shutdown. Every path MUST perform at most one
listener close.

Event delivery MUST retain no
more than 8 MiB for replay, admit at most 16 concurrent followers for an
active run, release a follower slot when it closes, and immediately disconnect
a follower whenever a replay or live stream write reports false.

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

Managed-controller startup MUST run host-state migration immediately after it
claims controller PID ownership and before plugin loading, route initialization,
or listener creation. It emits stable operator output only after a migration or
backup recovery completes. Migration failure is identified as its controller
startup stage and prevents plugins and listeners from starting.

Every ordinary built-in other than the runtime-session exceptions below, and
every plugin host-admin operation, MUST acquire the host lifecycle lock before
dispatch, confirm the host is `ready`, and retain that admission until it
completes. This includes every lifecycle mutation. Host shutdown MUST acquire
the same lock before capturing its workspace, CI-runner, and managed-container
recovery targets, so target capture and service drain wait for those admitted
operations. A later operation that waited behind maintenance MUST reread host
state after acquiring the lock and reject without dispatch when the host is not
`ready`. Host start owns its lifecycle admission and performs recorded
workspace start or immutable setup replay within that operation; those recovery
calls MUST NOT be blocked by attempting ordinary workspace admission again.

`workspace.run`, `workspace.exec`, and `ci.runner.logs` MUST instead use short
runtime admission: acquire the host lifecycle lock, confirm `ready`, release the
lock, and only then dispatch the stream. This exception permits independent
runtime sessions to overlap but does not permit destructive lifecycle
mutations to overlap one another. Existing operation-specific checks remain
mandatory; workspace run/exec retain workspace readiness, ownership, and
per-workspace locking checks. A stop, discard, or host-maintenance operation
admitted after the readiness check MAY interrupt the stream, and the stream has
no atomic guarantee that host phase remains `ready` until it exits.

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
and starts resource-intensive user tools in dynamically created tool groups so
management commands retain a responsive execution path.

The canonical self-Project stores the agent's home in a Project-owned outer
named volume. The private daemon receives that volume at a fixed path and
bind-mounts it into the inner agent as `/home/dim-agent`; task dispatch sets
`HOME` to that path. Agent configuration persists across task processes and
inner-container recreation, while workspace discard removes the volume through
reviewed teardown.

**PROJECT-AGENT-TMPDIR-001:** The canonical self-Project and representative
full-development-flow Project MUST set the agent process `TMPDIR` to
`/mnt/opencode-tmp`, backed by a dedicated Project-owned named volume in the
agent's private daemon. Only the untrusted agent container mounts that volume;
the home, configuration, credential, trusted-workspace, and secret-bearing
runtime mounts remain separate. Before agent launch, reviewed Project code MUST
require a real, non-symlink directory owned by the agent UID and GID with mode
`0700`. It MAY initialize an empty new volume, but MUST reject a populated root
with incompatible ownership or mode without recursively rewriting or deleting
its contents. The volume MUST survive inner-agent recreation. Custom teardown
MUST remove only its exact owned name on both ordinary discard and
`--keep-volume` before the private daemon store is removed or retained.

The optional canonical workspace-user bootstrap installs pinned OpenCode and
companion package versions below that home. OpenCode configuration remains in
its home-confined XDG directory. OMO 4.19.4 configuration is
`$HOME/.omo/omo.jsonc`; `["[opencode]"].team_mode` is bounded to
`enabled=true`, `max_parallel_members=4`, `max_members=8`, and
`tmux_visualization=false`. These are Project-owned user settings, not DIM
configuration or authority.

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
  fast-forward and setup, and may also replace Compose profiles. When the
  selected root is unchanged, DIM reuses the running workspace container and
  does not interrupt its nested runtime merely to repeat setup. When the
  selected root changes, DIM replaces the owned outer container before
  publishing the runtime manifest or running setup; this may interrupt outer
  processes and every nested runtime while preserving the workspace's named
  persistent data volume.
- `setup` retries from the immutable repository selection already recorded by
  the workspace. For `setting-up`, `setup-error`, or recovery from `error`, it
  repeats root publication and Project runtime manifest publication before
  Project setup and final ready publication, without fetching or resolving any
  repository ref.

Project setup MUST treat the stored profile list as authoritative. Repeated
setup after profile replacement MUST stop a deselected optional outer daemon
and stop or remove deselected workloads inside persistent nested daemons;
restart policies from an earlier setup MUST NOT retain capabilities that are no
longer selected.

**WORKSPACE-IMMUTABLE-ROOT-MOUNT-001:** Before trusted setup or task dispatch,
DIM MUST inspect the owned container by immutable container ID and verify that
exactly one read-only bind mount maps the canonical root snapshot source derived
from the state root, Project ID, and recorded commit to
`/run/dim/project-root`. A selected-root change MUST enter a non-ready phase
before replacement. Replacement MUST remove only the inspected owned container
and MUST preserve its named persistent data volume. Any replacement,
publication, or setup failure MUST remain non-ready. Recovery MUST reconcile a
mismatched owned mount or reject it before executing trusted Project bytes.

**WORKSPACE-SELECTED-ROOT-PUBLICATION-001:** After preflight accepts a selected
root, DIM MUST atomically record its ref, commit, and a non-ready
workspace phase before mutating the Project runtime manifest. The
workspace MUST remain non-ready until publication and setup complete and the final
ready record is durably published. Any manifest, setup, or final ready-state
publication failure MUST leave a non-ready record bound to that selected root.
`run` MUST reject every non-ready phase. `setup` MUST recover using the recorded
root asset by acquiring the Project lock and
then the workspace setup lock, revalidating the Project and workspace identity
under both locks, and repeating Project runtime manifest publication before
Project setup. DIM MUST NOT fetch or resolve a non-root repository ref during
this recovery. `update` MUST
be able to select and publish a root again; only successful setup may return
the workspace to `ready`.

Project-owned setup decides how mutable checkouts are reconciled and must not
silently rewrite an existing agent checkout. DIM restart selects reviewed root
bytes before stopping the container, then dispatches setup from those immutable
bytes. Stop/start and restart preserve workspace data and the named
inner-engine volume.
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

Both discard forms MUST revoke workspace and agent grants and External URL
routes before state removal. `--keep-volume` retains data only. A later
same-name create MUST use a fresh workspace ID and fresh grants, and every
token, route ID, approval, slug, or permalink bound to the discarded ID MUST
remain invalid as required by `WORKSPACE-AUTHORITY-001` and
`URL-APPROVAL-001`.

The `discarding` phase and grant revocation MUST be durable before cleanup hooks
run. Controller and plugin operations authenticated before that transition MUST
fully buffer any untrusted request body within the controller bound, then
revalidate the workspace ID and phase under the workspace authority lock before
dispatch. The authority lock is distinct from the workspace setup lock so
Project setup can call host-input providers while retaining exclusive setup
ownership. Discard MUST acquire setup and then authority, publish `discarding`
and revoke grants while both are held, and release authority before cleanup.
No path may hold authority while waiting for setup. Host shutdown MUST stop an owned running container left in
`discarding` without changing that phase or scheduling it for normal resume.

**PROJECT-DELETION-001:** `project remove` and `project purge --yes` MUST
acquire the Project lock and then the Project-scoped CI-runner lock. Both MUST
refuse while the Project is referenced. `project remove` MUST leave the
reserved Gitea organization in place. `project purge --yes` MUST delete each
DIM-managed Gitea repository before deleting that organization. Both commands
MUST remove protected root snapshots before deleting the final Project state.
If any required cleanup fails, the Project state MUST remain so a retry can
complete cleanup. A purge retry MUST treat an already-absent managed Gitea
repository or organization as successfully cleaned up.
For external Gitea, the host-admin `project purge --yes` and `repo delete
--yes` operations MUST perform the same checked remote deletion. Because the
service and Project binding can be shared by independent DIM state roots, a
successful deletion intentionally makes the deleted repository or organization
unavailable to every other attached host; their local records are not
coordinated or removed automatically. `project remove` remains the local
detach operation and MUST NOT mutate the external service.

## Verification

Required tests cover:

- atomic Project/repository/workspace claims and schema rejection;
- two Projects using the same repository alias without collision;
- empty creation, standard initial push, delayed protection, and import;
- host/workspace URL separation and credential-free output;
- root selection validation and runtime manifest injection;
- no live update of a running workspace;
- start/restart immutable-root selection and persistent-data preservation;
- task/raw command dispatch, stop persistence, discard cleanup, and both
  teardown keep-volume values;
- Project deletion refusal while referenced, Project-to-CI-runner lock order,
  Gitea repository-to-organization cleanup order, protected-snapshot cleanup
  before Project state deletion, retained state after cleanup failure, and
  successful retry when managed Gitea resources are already absent;
- schema-`7` root identity, commit-derived protected-root path, and canonical workspace-data path, schema-`3`
  catalog-free runtime publication, and rejection of obsolete state before
  mutation;
- Project-owned non-root ref selection, staged hook-safe materialization,
  retry, existing-checkout preservation, and non-Git destination rejection;
- complete workspace container and volume ownership labels and identity
  digests, inspected-ID-only container mutations, post-create inspection,
  volume reinspection before removal, and same-name replacement races;
- refusal to delete the selected importing repository before provider or state
  mutation, without blocking deletion of a ready target whose sibling imports;
- protected-root commit pinning, atomic full-tree snapshot publication,
  canonical path derivation without `rootSnapshotPath` retention, read-only outer mounting, mutable-file
  substitution resistance, missing snapshot rejection, and retry/discard
  provenance pinning;
- selected-root metadata publication before checkout or manifest mutation,
  non-ready state and `run` rejection after fault-injected checkout, manifest,
  and final ready-state write failures, plus recovery through `setup` and
  `update`;
- explicit, checksum-verified workspace-user setup through the Project task
  boundary, with user-home-only mutation and no automatic lifecycle install;
- explicit authenticated Web launch with bad-input and missing-prerequisite
  rejection, bounded authenticated readiness, listening-socket ownership,
  exact process and URL reuse, authenticated-orphan and unrelated-process
  survival, startup-failure cleanup, and no lifecycle launch;
- packed CLI help, JSON output, URL stdout, and Git credential wrapper.
