# Project Workspaces

Before adopting this workflow, follow the mandatory [DIM adoption and trust
requirements](adoption.md). In particular, a human must review the complete DIM
and project repositories and all secret-bearing environment code at the pinned
revisions.

This document defines the project-facing workspace workflow. Repository
registration and managed Gitea details are documented in
[Repository-backed Workspaces](repo-workspaces.md). For a complete, tested
walkthrough instead of a reference, see
[Example: External URLs](../../examples/features/external-urls/README.md).

## Concepts

A **repository** is a Git repository registered with the managed Git service.
Repository registration is role-neutral.

A **Project** is DIM metadata with one root repository and optional additional
managed repositories. The root repository's optional `.dim` directory defines
how that Project prepares its environment and dispatches tasks.

A **workspace** is a named, persistent, isolated environment bound to one
project. It owns its top-level runtime, inner-Docker state, selected profiles,
and lifecycle journal.

A workspace **profile** is a Docker Compose capability profile: for example
`development`, `secrets`, `browser`, or `gpu-tools`. It selects optional
project services and is unrelated to the CPU, memory, and PID limits set on
the top-level workspace. DIM does not impose a disk quota; see [Workspace
Runtime Backends](runtime-backends.md).

A **service** is a container managed by the project, normally through
`.dim/docker-compose.yml`. Services may clone additional registered
repositories directly from the managed Git service into their own named
volumes. `dim` does not require every repository to be cloned into the
top-level workspace or mapped one-to-one to a container.

A Project may keep code that can affect secret-bearing environments in a
separate repository with stricter review rules. DIM records that repository
without assigning it a special runtime role; the root lifecycle and the
Project's protected-branch policy decide how it is consumed. Secret material
itself must not be committed to any Project repository.

## Project contract

Only files below `.dim` have special meaning:

```text
project/
├── .dim/
│   ├── setup.sh             optional
│   ├── entrypoint.sh        optional
│   ├── teardown.sh          optional
│   └── docker-compose.yml   optional
└── ...                      all other layout is project-defined
```

`dim` does not discover or run a `compose.yaml` from the repository root.
Projects remain free to use a root Compose file for their own non-`dim`
workflow.

### `.dim/setup.sh`

When present, this script completely owns environment reconciliation. It may
clone or update additional repositories, build images, and start project
services. DIM runs its reviewed bytes from the immutable snapshot of the exact
protected root commit recorded by the workspace. Its working directory is that
snapshot, `DIM_PROJECT_ROOT` names the same immutable root contract, and
`DIM_WORKSPACE_DATA` names persistent Project-owned mutable data, with:

```text
DIM_PROJECT_ID
DIM_PROJECT_NAME
DIM_PROJECT_ROOT
DIM_PROJECT_MANIFEST
DIM_WORKSPACE_DATA
DIM_WORKSPACE_NAME
DIM_WORKSPACE_BACKEND
DIM_NESTED_ENGINE
COMPOSE_PROJECT_NAME
COMPOSE_PROFILES
DIM_GIT_BASE_URL
DIM_GIT_USERNAME
DIM_GIT_TOKEN
DIM_CONTROLLER_SOCKET
DIM_CONTROLLER_TOKEN
DIM_AGENT_CONTROLLER_SOCKET
DIM_AGENT_CONTROLLER_TOKEN
```

`COMPOSE_PROJECT_NAME` is the stable workspace-local name `dim-project`.
Project lifecycle scripts should use that environment value (or let Compose
consume it automatically), rather than deriving an inner Compose identity
from `DIM_WORKSPACE_NAME`.

The read-only `DIM_PROJECT_MANIFEST` also publishes the nested engine's cgroup
boundary under `runtime.cgroups`. DIM exposes delegation automatically when it
is safe. `status: delegated` means Project setup may
use `/usr/local/bin/dim-project-cgroup` to create named descendants beneath the
workspace aggregate boundary. The record identifies the `systemd` or
`cgroupfs` driver and the available controllers. `status: unavailable` carries
an actionable reason but does not block ordinary Project setup. Projects that
require resource enforcement can opt into fail-closed setup with
`dim-project-cgroup require`. See the
[Project runtime cgroups example](../../examples/features/project-runtime-cgroups/README.md).

The schema-3 manifest identifies the immutable reviewed root at
`/run/dim/project-root`, persistent Project-owned data at
`/var/lib/dim/workspace-data`, the managed Git base URL, host aliases, and
generic runtime capabilities. It contains no repository catalog. Reviewed
Project code owns repository aliases, refs, checkout paths, staging, and retry
policy. It must preserve an existing agent checkout rather than silently
fetching, switching, merging, or resetting it.

Selected profiles are passed as repeated arguments:

```bash
.dim/setup.sh --profile development --profile secrets
```

The script must be safe to retry after partial failure. It is invoked by
`create`, `start`, `setup`, and after a
successful `update`. It is not invoked by `run` or
`exec`.

Trusted setup prepares Project infrastructure. It must not install a coding
agent's personal tools or configuration. Projects that offer such a bootstrap
should publish it as an explicit workspace-user action and run it through an
agent task after setup has completed. Keeping that mutation below the agent's
persistent home lets it survive task processes and agent-container recreation
without giving the script trusted lifecycle authority.

The trusted project root can request narrowly defined, non-secret host
settings from installed providers:

```bash
name="$(dim-host-input builtin.git-author name)"
email="$(dim-host-input builtin.git-author email)"
```

`builtin.git-author` accepts only `name` and `email`; it is not an arbitrary
Git configuration reader. Providers run in DIM's managed host controller on
every request, and DIM does not cache their results. The controller socket and
grant are not inherited by Compose services.

The workspace API also accepts an asynchronous self-restart request at
`POST /api/workspace/restart`. The scoped grant determines the workspace; the
request has no workspace-name field and cannot target another workspace.
Agent containers may receive the separate `DIM_AGENT_CONTROLLER_*` socket and
grant for explicitly agent-audience plugin routes. They must not receive this
stronger workspace socket or grant. The runnable single-repository Project
uses the standard `dim-controller-proxy` only for the additional self-restart
capability, which is intentionally absent from the direct agent controller.

### `.dim/docker-compose.yml`

When `.dim/setup.sh` is absent and this file exists, `dim` performs the default
setup:

```bash
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --file .dim/docker-compose.yml \
  [--profile PROFILE ...] \
  up --detach --build
```

Compose runs against the workspace's inner Docker daemon. The Compose file and
relative build contexts are resolved from the immutable root snapshot, never
from the mutable checkout or a host checkout. A service that needs mutable
Project data must bind it explicitly through `DIM_WORKSPACE_DATA`. The snapshot
itself must not be mounted into an untrusted agent runtime. The fixed Compose
project name lets reconciliation and cleanup distinguish resources belonging
to different workspaces.

When neither setup mechanism exists, setup is a successful no-op. The
workspace remains useful for direct commands and projects that manage their
environment through another tool.

### `.dim/entrypoint.sh`

When present, `run` passes the task name and arguments to this
script:

```bash
exec sh .dim/entrypoint.sh TASK [ARGS...]
```

For example:

```sh
#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  bash)
    exec bash "$@"
    ;;
  test)
    exec docker compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --file .dim/docker-compose.yml \
      --profile development \
      run --rm test "$@"
    ;;
  *)
    echo "unknown task: $task" >&2
    exit 2
    ;;
esac
```

When the entrypoint is absent, `run` executes the supplied task and
arguments directly from the project root. `exec` always bypasses
the entrypoint.

Projects may define a generic `ssh-proxy` entrypoint task for remote access to
their fixed agent container. This optional pattern forwards raw stdio without
a TTY and publishes no SSH port. The canonical self-Project uses key-only
authentication and a fixed non-root `dim-agent` login, generates host keys at
runtime, and keeps authorized keys in the persistent agent home. It grants that
login practical agent authority through namespace-local ACLs for workspace
content and the private nested Docker socket, without changing checkout
ownership or making the workspace world-writable. A root-owned ephemeral
allowlist supplies current Git, Docker, and constrained endpoint settings to
each fixed-shell session, so clients cannot replace them or persist them in
home state.

A key trusted for this pattern can modify agent-visible source and home data,
use the agent's private Docker daemon and Git credentials, and call any
constrained agent endpoints the Project exposes. It must not receive a host,
trusted-workspace, or Project-runtime control socket. Projects that copy this
pattern must review those grants for their own layout rather than treating it
as authority shared by every DIM Project. Verify the runtime host-key
fingerprint before connecting, and disable root login even for a key accepted
for `dim-agent`. Connecting a Codex client is one use case; DIM does not add an
SSH command or own this Project task.

### `.dim/teardown.sh`

When present, this script receives the same environment and repeated profile
arguments as setup and runs before discard. DIM additionally sets
`DIM_WORKSPACE_DISCARD_KEEP_VOLUME=0` for ordinary discard and `1` for
`--keep-volume`. At `1`, custom teardown must preserve nested named data meant
to survive recreation of the same workspace name. At `0`, it retains its
ordinary cleanup authority. When the script is absent and
`.dim/docker-compose.yml` exists, `dim` performs:

```bash
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --file .dim/docker-compose.yml \
  down --remove-orphans
```

Teardown does not include `--volumes` by default. The DIM-managed outer volume
stores the workspace's inner Docker engine. Named volumes created by Compose
inside that engine remain Project-owned, even though removing the outer engine
volume makes them unreachable. External volumes sit outside both ownership
boundaries and remain the Project's responsibility.

## End-to-end workflow

Create the Project root and populate it with standard Git:

```bash
dim project create example
dim repo add example root /path/to/example \
  --root --ref main --protect main
```

The invoking host Git CLI mirrors the source into managed Gitea and existing
host credential helpers or SSH configuration apply to the source URL.

Create a workspace and persist its desired Compose profiles:

```bash
dim workspace create example example-dev \
  --profile development \
  --profile secrets
```

When host `/dev/kvm` exists as a character device, interactive creation asks
whether to pass it into supported trusted workspace backends and recommends
acceptance. Use `--kvm` or `--no-kvm` for an explicit choice; non-interactive
creation continues to enable available KVM by default. The DIM process
does not need to open the device itself; the container runtime does that and
the supplemental group gives the workspace user access. DIM records the effective result in workspace state and
exposes it as `DIM_WORKSPACE_KVM=0|1`. It does not place the workspace
container in a VM. A VM started there is therefore the first virtualization
layer and may use host-supported nested virtualization itself.
When disabled, DIM omits its explicit KVM device and group grant. The trusted
Project lifecycle container is privileged, so `/dev/kvm` may nevertheless be
visible there on an ordinary runc host; path absence in that trusted container
is not a lifecycle or setup guarantee. The untrusted agent must never receive
the device, and CI verifies that boundary from inside the completed agent
container rather than during workspace lifecycle operations.

Creation:

1. Claims the workspace journal before creating non-trivial resources.
2. Reconciles the managed Git service and workspace runtime.
3. Clones the project repository inside the workspace.
4. Stores the selected runtime backend and profiles in workspace metadata.
5. Runs `.dim/setup.sh`, or the default `.dim/docker-compose.yml` setup.
6. Leaves failed setup resources and diagnostics available for retry.

Run project-defined tasks without repeating setup:

```bash
dim run example-dev bash
dim run example-dev bash -- -lc 'just test'
dim run example-dev tool-setup <reviewed-tool-setup.bash
dim run example-dev agent
dim run example-dev backup >example-dev-home.tar.gz
dim run example-dev restore <example-dev-home.tar.gz
```

`dim run` is the short form of `dim workspace run`. It enters the checked-in
Project task boundary, which may dispatch `bash` into a Project-owned agent.
Projects may conventionally expose `tool-setup` for an explicit reviewed
user-home setup program and `agent` for the compatible installed launcher.
Those generic names do not select a tool in DIM. The Project entrypoint maps
them to a reviewed utility, expected contract version, launcher name, pinned
tool identity and version, and executable path. `run` does not invoke either
task by itself.

To offer an optional OpenCode bootstrap, publish
`scripts/workspace-user-setup.bash` and its `.sha256` file from the development
repository. Download both from one full development commit, verify the local
file, then stream those verified bytes to the existing `bash` task. For
example, replace the URL and commit with the canonical development
repository's immutable raw-file URL and full commit ID:

```bash
(
  set -euo pipefail

  development_commit="${DIM_DEVELOPMENT_COMMIT:?set a full development commit}"
  [[ "$development_commit" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'development commit must be exactly 40 lowercase hex characters\n' >&2
    exit 2
  }

  : "${DIM_DEVELOPMENT_RAW_ROOT:?set the development repository raw-file root}"
  development_raw_root="${DIM_DEVELOPMENT_RAW_ROOT%/}"
  artifact_base="${development_raw_root}/${development_commit}"
  download_dir="$(mktemp -d)"
  trap 'rm -rf -- "$download_dir"' EXIT

  curl --fail --silent --show-error --location \
    --output "$download_dir/workspace-user-setup.bash" \
    "${artifact_base}/scripts/workspace-user-setup.bash"
  curl --fail --silent --show-error --location \
    --output "$download_dir/workspace-user-setup.bash.sha256" \
    "${artifact_base}/scripts/workspace-user-setup.bash.sha256"
  (
    cd -- "$download_dir"
    sha256sum --check workspace-user-setup.bash.sha256
  )
  dim run example-dev tool-setup <"$download_dir/workspace-user-setup.bash"
)
```

Set `DIM_DEVELOPMENT_COMMIT` to exactly 40 lowercase hexadecimal characters
and `DIM_DEVELOPMENT_RAW_ROOT` to the Git provider's raw-file repository root,
ending immediately before the commit segment. A trailing slash is accepted and
normalized. Don't pipe a mutable URL into a shell. The script and checksum come
from the same validated commit, checksum failure prevents execution, and the
exit trap removes both downloads.

The script may install pinned user-local executables and agent configuration
only below the canonical agent home. It rejects an XDG configuration directory
or cache directory, including a symbolic-link target, that resolves outside
that home. `XDG_CACHE_HOME` defaults to canonical `$HOME/.cache`; a contained
symlink is exported as its canonical target. OpenCode configuration stays below
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. OMO 4.19.4 uses
`$HOME/.omo/omo.jsonc`, with the bounded settings at
`["[opencode]"].team_mode`: `enabled=true`, `max_parallel_members=4`,
`max_members=8`, and `tmux_visualization=false`.

The npm install prefix, cache, and user configuration file are canonical
descendants of `HOME`; inherited npm settings cannot redirect those mutation
roots. The npm cache and user configuration remain separate from
`XDG_CACHE_HOME`. Setup serializes overlapping invocations with flock-equivalent
exclusive lock semantics across package installation, configuration, and final
version verification. A failed holder cannot leave a permanent lock. Setup
applies targeted JSONC edits so unrelated properties, comments, and plugin
options survive. Each file is replaced without exposing partial content. Package and
multi-file configuration updates are not one transaction; after interruption,
rerunning the script must converge on the documented state. The script must not
authenticate the tool, change global Git configuration, start a web interface,
or request DIM controller or plugin access.

After successful setup, the canonical utility writes a mode-restricted
manifest and launcher below canonical `$HOME/.local`. The manifest contract
version is `1` and names launcher entries without defining them in DIM core.
Before executing `agent`, Project-owned dispatch validates the supported
contract version, requested launcher, pinned tool identity and version, the
exact executable path, and its canonical target below `HOME`. Missing, unknown,
escaping, or incompatible state fails before execution. A Project can replace
the mapping only by reviewing its own setup and entrypoint together; lifecycle
setup does not infer, install, authenticate, or launch the tool.

An optional Web launcher is a separate explicit workspace-user action. It must
require the pinned OpenCode installation instead of downloading or silently
upgrading it. Before binding loopback, it configures OpenCode Basic Auth, keeps
the credential out of command arguments and logs, and persists it only in a
mode-restricted canonical user-home state directory. Routine output reports
that file rather than the password; reading its username/password lines is a
separate explicit action. Readiness uses the
authenticated `/global/health` endpoint. A retry may reuse only the exact
recorded live process after proving that process owns the listening socket,
and it must not discover and kill processes by command substring. External
exposure uses `dim-development-service expose` with a stable service name, the
selected local port, and an HTTPS scheme requirement. The launcher receives
only `DIM_DEVELOPMENT_URL_SOCKET`, not target/container metadata, a raw
controller grant, or a host secret. The helper owns stable URL reuse and a
shared gateway that listens on the agent-container gateway port and forwards
only to loopback applications; changing the application port updates only its
named gateway route. Lock acquisition, the complete helper process tree,
readiness, and cleanup are bounded. Selecting another ingress cannot widen the
trusted proxy's allowlist.
Installation/configuration remains non-launching. One launcher failure or
retry must not stop the gateway shared by other development services.
The launcher must always supply `https://localhost:4096` as an exact CORS
origin. `OPENCODE_WEB_CORS_ORIGINS` is a JSON array of additional exact HTTP or
HTTPS browser client origins and defaults to `[]`. The origin identifies the
source Web UI, not the destination DIM external URL. Before creating state, the launcher rejects
invalid JSON and values containing a wildcard, user information, path, query,
or fragment. It normalizes URL origins, removes duplicates, sorts the result,
and passes each value through a separate OpenCode `--cors` argument. The pinned
OpenCode release does not implement `*` as a wildcard origin. OpenCode may also
merge origins from server configuration or built-in behavior, so the launcher
list is not a universal deny list.

CORS headers from OpenCode pass through the external URL route. Preflight must
permit the `Authorization` and `Content-Type` headers used by the browser
client. Later requests remain subject to Basic Auth and must send the reported
credential in `Authorization`. The launcher may reuse a healthy owned process
only when its port and canonical CORS list match. A change to either setting
must restart only the recorded owned process, preserving the credential,
stable external URL, and helper-managed shared gateway. Projects should allow
only trusted browser UI origins.

Backup and restore are Project-defined tasks rather than DIM lifecycle
operations. A Project can use stdin/stdout streaming for its chosen format and
scope. The canonical examples stop the agent while a networkless temporary
container archives only its named home volume. Backup mounts that volume
read-only; restore replaces its contents through a read-write mount. The agent
is restarted afterward if it was running before the task. `workspace run` and
`workspace exec` forward stdin for redirected and interactive invocations;
only an actual terminal session requests a TTY from the workspace runtime.
For an interactive invocation, the managed controller creates the host-side
PTY, applies the CLI's initial dimensions, and forwards later terminal resize
events. Internal reconciliation and readiness probes are not part of the task
output stream.

Run a raw command in the trusted top-level workspace:

```bash
dim exec example-dev -- bash
dim exec example-dev -- docker compose \
  --file .dim/docker-compose.yml ps
```

`dim exec` is the short form of `dim workspace exec`. It always bypasses the
Project entrypoint and enters the trusted workspace container. Use it for
recovery and Project lifecycle administration, not as the coding-agent task
boundary. There is no separate `workspace shell` command; `exec NAME -- bash`
is the explicit equivalent.

Update the project and reconcile its environment:

```bash
dim workspace update example-dev
dim workspace update example-dev \
  --profile development \
  --profile production
```

`update` pins and stages one commit from the applied protected root branch,
publishes the same commit's immutable setup bytes, and invokes reviewed setup.
DIM does not rewrite mutable checkouts. If one or more `--profile` flags are
provided, they replace the stored profile set; otherwise the existing set is
retained. Additional repository update policy belongs to `.dim/setup.sh` or
the services that own those repositories. An update that selects the currently
mounted root reuses the outer container and nested runtime. Selecting a
different root safely replaces the outer container first, which may interrupt
outer processes and nested runtimes; the named persistent data volume remains
attached to the replacement.

Stop and resume the environment:

```bash
dim workspace stop example-dev
dim workspace start example-dev
```

`stop` preserves Project-owned data and inner-Docker state. `start`
pins an approved commit, reconciles the runtime, and invokes its immutable setup so
detached project services return to their desired state. Use `restart` to
apply the same sequence to a running workspace:

```bash
dim workspace restart example-dev
```

Retry setup explicitly:

```bash
dim workspace setup example-dev
```

If setup stopped in `setting-up` or failed into `setup-error`, this command
replays the checkout and runtime manifest from the immutable root already
recorded for the workspace, then reruns Project setup. It doesn't fetch or
follow the configured root ref, so a branch moving after the original
selection can't change the recovery input. The workspace remains non-ready
until every replay and setup step succeeds. Recovery also verifies that the
outer container's read-only root mount matches the recorded snapshot and
reconciles a mismatch before manifest publication or setup.

Inspect or discard:

```bash
dim workspace show example-dev
dim workspace discard example-dev --yes
dim workspace discard example-dev --keep-volume --yes
```

Discard stops project services when possible, then removes the top-level
runtime, project checkout, workspace journal, and the DIM-managed volume that
stores the inner Docker engine. With `--keep-volume`, DIM retains that outer
engine volume for a later workspace creation using the same name and tells
custom teardown to preserve Project-owned nested named data intended to
survive that recreation. Ordinary discard leaves custom teardown free to
remove nested Project data. External volumes always remain Project-owned.
Discard does not remove repositories from the managed Git service.

## Lifecycle behavior

| Command | Project Git update | Setup | Project entrypoint |
|---|---:|---:|---:|
| `create` | initial clone | yes | no |
| `start` | fast-forward only | yes | no |
| `restart` | fast-forward only | yes | no |
| `setup` | reuse; reapply recorded immutable root on recovery | yes | no |
| `update` | fast-forward only | yes | no |
| `run` | no | no | when present |
| `exec` | no | no | never |
| `stop` | no | no | no |
| `discard` | no | teardown only | no |

Setup acquires the Project lock before the workspace setup lock and rechecks
the Project and workspace identity while both are held. Ordinary tasks may run
concurrently. `setup` and discard reuse the snapshot already recorded in
workspace state; they never follow a moved branch. Missing recorded snapshot
bytes fail closed.
Setup failure is recorded separately from runtime reconciliation failure and
does not destroy the checkout or inner-Docker cache. Task failure is returned
to the caller but does not mark the workspace itself unhealthy.

Lifecycle lock ownership follows the exact Linux process instance rather than
lock age. Long setup, Packer, or QEMU work therefore remains exclusive while
its owner is alive; dead owners and reused PIDs can be reclaimed. Corrupt or
unverifiable owner state blocks until the bounded timeout and is reported for
operator repair. Release is tied to the acquisition nonce, so a delayed old
release cannot remove a successor's owner record. This applies without merging
the distinct Project, runner, hook-publication, workspace-setup, and workspace
reconciliation lock identities or changing their documented ordering.

DIM identifies the outer workspace container with its managed owner,
workspace, Project name and ID, root alias, backend, resource kind, and
identity-digest labels. The inner-engine volume carries the matching managed
owner, workspace, Project name and ID, resource kind, and identity digest.
Lifecycle actions reject incomplete, malformed, foreign, or mismatched
same-name resources. Container changes use only the ID returned by ownership
inspection. Docker volume deletion remains name-based because Docker exposes no
equivalent immutable volume ID, so discard reinspects complete ownership
immediately before deleting the volume.

For Docker or host maintenance, `dim host shutdown` stops all DIM runtimes
without removing their named volumes and leaves the controller available in a
not-ready maintenance state. After maintenance, `dim host start` restores
Gitea and the registry cache before restarting only the workspaces and CI
runners that were ready at shutdown. `dim host status --json` reports the
phase and any pending recovery error. If one target fails, DIM still attempts
later targets where the recovery order permits it and retains all still-pending
restart intent. Repeat `dim host start` after correcting the failure. Host
lifecycle state is schema 2 and records CI intent in `restartCiRunners`; schema
1 is migrated at managed-controller startup only when it has the exact
historical shape. DIM renames `resumeCiRunners`, preserves all other fields,
and keeps the original bytes permanently in mode-`0600`
`host.json.schema-1.bak`. Migration runs before plugins and listeners and fails
closed on malformed, conflicting, extra-key, symlink, or non-regular artifacts.
An interrupted migration can be retried or recovered from that backup. A ready
runner absent from the schema-2 list is left alone. The retry also leaves ready
workspaces alone, starts stopped targets, replays interrupted workspace setup
from its immutable selection, and
normalizes interrupted CI runner creation through an ownership-checked
stop/start. A workspace still being created fails closed. The host clears its
recovery lists only when every target has recovered.

DIM configures its workspace Docker engine to use the same managed,
host-scoped anonymous Docker Hub pull-through cache as managed CI runners.
The cache remains outside Project-defined networks and Project code does not
need cache-specific configuration. A Project-defined additional container
engine, such as a DinD Compose service, remains Project-owned and is not
rewritten by DIM. On the first setup, start, or restart after this runtime
configuration changes, DIM replaces only the outer workspace container while
preserving its checkout and engine data volume.

## Minimal Compose example

DIM does not generate project files. Add `.dim/docker-compose.yml` directly
when the root repository needs a Compose-managed development service:

```yaml
services:
  dev:
    build:
      context: ..
    command: sleep infinity
    working_dir: /workspace
    volumes:
      - ..:/workspace
```

Projects needing custom checkout, non-Compose orchestration, or task aliases
can add `.dim/setup.sh` and `.dim/entrypoint.sh`. These files are ordinary
project files and may be invoked directly without `dim`:

```bash
docker compose --file .dim/docker-compose.yml up --detach --build
```

When invoking hooks directly, callers can supply the same standard Compose
environment used by `dim`:

```bash
COMPOSE_PROJECT_NAME=example-dev \
COMPOSE_PROFILES=development,secrets \
sh .dim/setup.sh --profile development --profile secrets
```

## Multiple repositories

The project repository is the only checkout required in the top-level
workspace. Other repositories need not be bind-mounted from it.

Services can reach the managed Git service and may clone into service-specific
named volumes. `DIM_PROJECT_MANIFEST` and the Project-specific
`DIM_GIT_BASE_URL` let project code construct routable repository endpoints.
The manifest's `hostAliases` mapping supplies controller-approved names, such
as `dim-gitea`, for nested services whose Docker DNS cannot inherit the
workspace container's aliases. Project setup applies those aliases only to
the services that need them; ordinary intranet and public names continue to
use DNS normally.
Projects explicitly
pass `DIM_GIT_USERNAME`, `DIM_GIT_TOKEN`, and an askpass helper when a service
also needs to push. Repositories used only as
image build inputs may use a Git build context. Projects that require
centralized checkout behavior can implement it in `.dim/setup.sh`; this is a
project choice rather than a `dim` requirement.

The multi-repository container smoke covers:

- A project repository containing `.dim/docker-compose.yml`.
- Separate secret-handling and multiple product repositories.
- Direct managed-Git access from nested services.
- Service-owned persistent checkout volumes.
- Compose profile selection stored by `create`.
- Project task dispatch through `.dim/entrypoint.sh`.
- Stop/start persistence, update/setup retry, and complete discard cleanup.
