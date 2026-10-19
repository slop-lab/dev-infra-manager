# dev-infra-manager

DIM provides persistent, isolated development workspaces on Linux hosts. Start
from an ordinary Git URL or a repository on the selected host; a DIM control
plane and `.dim` configuration are not prerequisites. Checkout, home and the
workspace's private Docker data and separate temporary volume persist across
restarts and recreation.

The default runtime is an unprivileged Sysbox container with its own Docker
engine. The workspace does not receive the host Docker socket or a writable
bind of the host checkout. These are practical development isolation boundaries,
not a claim that arbitrary hostile workloads cannot escape the host kernel.

Managed Git, proposal/review workflows, CI and development URL integrations are
optional. They are separated from the base workspace dependency and startup path;
see the [preserved issue implementation](specification/docs/preserved-issues-implementation.md)
for the issue-by-issue implementation and verification evidence.

## Install and start

This `development` branch contains the new base workspace flow. Published
`0.10.0` packages still contain the earlier managed-only architecture. To use
these commands, install a prepared source build:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
mise install
pnpm install --frozen-lockfile
just prepare-local
just install-local
```

The preparation builds the package bundle and base workspace image. The install
selects the base CLI and its dependencies; optional managed packages in the same
bundle are not automatically installed. It retains the matching source installer and selects it through mise when
available. Without mise, it prints the persistent facade path to add to PATH.
See the [source installation workflow](specification/docs/usage.md#install-development-sources) for
artifact provenance and prerequisites.

A runtime host needs Linux, Docker and `sysbox-runc`. For a new disposable Ubuntu
VM, the [role bootstrap](verification/bootstrap-ubuntu-vm.md) installs host
prerequisites. Installing the CLI does not grant Docker access or replace a
host runtime installation.

Build the workspace image on the selected host, then start developing:

```bash
dim image build
dim create https://example.com/team/app.git dev
dim ls
dim shell dev
dim exec dev -- docker compose up -d
```

Use a real repository URL in place of the example. To seed from a repository
already on the host, use its path. Local source acquisition copies committed
Git content into private storage; it does not copy dirty or untracked files or
write into the original checkout. A portable origin is retained for ordinary
fetch/push. Git credentials and host SSH agents are not forwarded into the
workspace.

No Project registration, protected-ref policy or scheduler is required for this
path. A source branch can be selected with `--ref`. Updating a user's working
checkout is an ordinary explicit Git operation; DIM does not reset user changes
during startup.

## Remote hosts

```bash
dim host add devbox --ssh developer@devbox
dim host use devbox
dim image build
dim create https://example.com/team/app.git dev
dim shell dev
```

Install DIM and the runtime prerequisites on `devbox` first. The client uses the
existing SSH connection to invoke the host's DIM runtime. Workspace files,
state and Docker operations belong to that host. There is no public host-admin
HTTP endpoint to configure. `--host local` selects the local host for one command.
Paths passed as sources are paths on the selected host.

The host-side entry point requires Linux. The client transport does not require
a local Linux runtime; support for particular client platforms still needs
platform-specific verification.

## Lifecycle and data

```bash
dim stop dev
dim start dev
dim restart dev
dim recreate dev
dim resources dev --cpus 4 --memory 8g --pids 2048
dim show dev --json
```

`recreate` replaces the container and preserves checkout, home and nested Docker
data. Existing initialized storage must be present and owned by that workspace;
missing storage is an error, not permission to create an empty replacement.
Resource limits accept `unlimited`. Removing an existing limit may replace the
container because Docker cannot clear every limit in place; the command reports
that replacement and retains the data.

`dim run dev` opens a shell. `dim run dev exec COMMAND...` and
`dim run dev custom COMMAND...` run ordinary commands inside the workspace.
Project-specific setup runs inside the workspace. Optional tool integration
belongs to the agent-tools plugin; the default path does not execute host-side
`.dim` hooks.

```bash
# Permanently removes checkout, home, private Docker data and temporary storage.
dim discard dev --yes
```

`dim workspace ...` offers the same workspace commands as the root CLI. Ordinary
read-only listing does not start a controller, install plugins or provision
caches. Interrupted initialization and runtime failures remain visible in state
for diagnosis and explicit cleanup.

## Optional managed services

The installer facade retains its namespace:

```bash
dim installer install plugin PACKAGE@EXACT_VERSION
dim installer install control-plane plugin PACKAGE@EXACT_VERSION
dim installer install control-plane --config /absolute/operator/install.json
```

Managed Git/review/CI operations remain available under `dim managed ...` in the optional managed component. The installer integration also keeps
`dim controller restart` directly reachable. The normal workspace path uses no
managed-Git role files and does not load its service implementation.

Use `dim managed control-plane prepare` to generate private deployment
configuration and `connect` to validate and save host connections. The advanced
installer configuration remains available. The operations and review web service
is a separate optional package with explicit account roles. DIM does not embed
an issue tracker.

Control-plane plugins run in the standalone
[`@slop-lab/dim-control-plane`](packages/control-plane/core/README.md) runtime.
Native Git, the CI workflow compiler and the LLM router have explicit
`dim-plugin-control-plane-*` package names. They install in a separate tree
without `dim-core`, the workspace CLI or managed host integration. See
[plugin locations and installation](specification/docs/plugin-scopes.md).

## Optional workspace plugins

Host plugins prepare their small workspace clients without repository `.dim`
configuration. Inside the workspace, `dim-workspace plugins` lists available
commands and setup status. Authentication, shared-service configuration and
large tool installations remain explicit operations. See
[guest preparation and plugin locations](specification/docs/plugin-scopes.md).

Install only the integrations needed on the selected host. `dim plugins` lists
the host's installed commands and runtime providers; remote clients need only
the base CLI.

| Package | Responsibility |
| --- | --- |
| [agent-tools](packages/host/plugins/agent-tools/README.md) | Codex/OpenCode setup, launch, session continuation and OpenCode server |
| [cache-server](packages/host/plugins/cache-server/README.md) | Optional host-owned Docker, npm, PyPI and APT cache services |
| [host-mirrors](packages/host/plugins/mirrors/README.md) | Workspace clients for local or remote package caches |
| [host-llm-router](packages/host/plugins/llm-router/README.md) | Workspace identity fencing, private gateway and OpenCode connection to a control-plane router |
| [vm](packages/host/plugins/vm/README.md) | Incus VM workspace runtime, persistent auxiliary VMs and scoped browser consoles |
| [tunnels](packages/host/plugins/tunnels/README.md) | Persistent TCP/UDP routes, workspace grants and operator web UI |
| [workspace-check](packages/host/plugins/workspace-check/README.md) | Disposable lifecycle/data-preservation checks for ordinary repositories |

Install the matching agent-tools tarball from the prepared source bundle with
`dim installer install plugin /absolute/path/to/plugin.tgz`, then run
`dim tools setup dev opencode`. Plugins own their service configuration and required
host prerequisites; installing a package does not implicitly log into an account
or initialize a VM host.

Inside a workspace, `dim-workspace resources`, `dim-nproc`, `dim-workspace restart`
and `dim-workspace recreate` use a connection scoped to that workspace's immutable
identity. Registered sessions and independent background services resume from
the persistent home. See the [guest client documentation](packages/host/core/docs/workspace-client.md)
for public-key SSH access and HTTP service publication.

## Development and verification

```bash
pnpm install --frozen-lockfile
just typecheck
just test
just build-packages
```

`just typecheck` checks both TypeScript and all source JavaScript (`.js`,
`.mjs`, `.cjs`) with the shared strict compiler settings. JavaScript sources
use `// @ts-check`; run `pnpm check:js` for that check alone.

Tests are under `tests/`; deployment and cross-component checks are under
`verification/`. The source gate and fresh VM bootstrap describe their own
host requirements. Targeted runtime verification with an already built image:

```bash
pnpm --dir tests exec tsx ../verification/scripts/base-workspace-runtime-smoke.mts IMAGE
```

This check creates disposable Sysbox resources, exercises nested Docker and
storage/resource lifecycle behavior, and cleans up its resources. Container
runtime evidence does not establish VM/KVM support. The VM plugin records its
separate hardware verification requirements and evidence. Coding-agent account
authentication and real provider inference also require independent verification;
local HTTP tests do not establish either.

Managed administration also follows the selected host:

```bash
dim --host devbox managed control-plane connect /srv/dim/deployment
dim --host devbox managed project list --json
dim --host devbox create dim://PROJECT dev
```

The remote host holds Project state and private role files. The client can have
only the base CLI; optional code is loaded on the host that executes the
operation. `dim host use devbox` selects that host for subsequent commands.
The root `dim controller ...` entry point stays local for installer activation;
use `dim --host devbox managed controller ...` for remote administration.
