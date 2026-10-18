# dev-infra-manager

DIM provides persistent, isolated development workspaces on Linux hosts. Start
from an ordinary Git URL or a repository on the selected host; a DIM control
plane and `.dim` configuration are not prerequisites. Checkout, home and the
workspace's private Docker data persist across restarts and recreation.

The default runtime is an unprivileged Sysbox container with its own Docker
engine. The workspace does not receive the host Docker socket or a writable
bind of the host checkout. These are practical development isolation boundaries,
not a claim that arbitrary hostile workloads cannot escape the host kernel.

Managed Git, proposal/review workflows, CI and development URL integrations are
optional. They are separated from the base workspace dependency and startup path;
see the [architecture rework plan](specification/docs/architecture-rework-plan.md)
for the remaining work and the exported issue backlog.

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
bundle are not automatically installed. It uses an existing mise installer
facade when configured and does not replace it with a direct CLI symlink.
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
Project-specific setup and tool integration are being separated from the base
runtime; the default path does not execute host-side `.dim` hooks.

```bash
# Permanently removes checkout, home and private Docker data.
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
dim installer install control-plane --config /absolute/operator/install.json
```

Managed Git/review/CI operations remain available under `dim managed ...` in the optional managed component. The installer integration also keeps
`dim controller restart` directly reachable. The normal workspace path uses no
managed-Git role files and does not load its service implementation.

Use `dim managed control-plane prepare` to generate private deployment
configuration and `connect` to validate and save host connections. The advanced
installer configuration remains available. The reviewer web service
is a separate optional package. DIM does not embed an issue tracker.

## Development and verification

```bash
pnpm install --frozen-lockfile
just typecheck
just test
just build-packages
```

Tests are under `tests/`; deployment and cross-component checks are under
`verification/`. The source gate and fresh VM bootstrap describe their own
host requirements. Targeted runtime verification with an already built image:

```bash
pnpm --dir tests exec tsx ../verification/scripts/base-workspace-runtime-smoke.mts IMAGE
```

This check creates disposable Sysbox resources, exercises nested Docker and
storage/resource lifecycle behavior, and cleans up its resources. Container
runtime evidence does not establish VM/KVM support. VM workspaces and automatic tool-specific session continuation remain future
product work; the architecture plan records their relation to the issue backup.

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
