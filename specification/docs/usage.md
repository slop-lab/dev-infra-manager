# Development workspaces

A runtime host needs Linux, Git, Docker and registered `sysbox-runc`. The client
can use that host locally or through an existing SSH connection. The default
flow requires no Project, control plane, CI service or `.dim` configuration.

## Install development sources

Published `0.10.0` packages use the earlier managed architecture. To try the
current base flow, prepare and install this branch's matched source bundle:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
mise install
pnpm install --frozen-lockfile
just prepare-local
just install-local
```

The first command installs the preserved facade. Preparation builds packages
and the base workspace image from one source identity and lockfile. Installation
uses those artifacts without rebuilding them, validates base workspace state,
and selects only the base CLI dependency graph. It does not activate a fresh
managed controller. Existing explicitly installed integrations are retained.
Preparation rejects dirty source by default; use a reviewed clean commit.

A source host bootstrap is available for a disposable Ubuntu VM in
[bootstrap-ubuntu-vm.md](../../verification/bootstrap-ubuntu-vm.md). Do not use
host provisioning commands inside an ordinary development workspace.

## Create and use

```bash
dim doctor
dim image build
dim create https://example.com/team/app.git dev --ref main
dim ls
dim show dev --json
dim shell dev
dim exec dev -- git status
dim exec dev -- docker compose up -d
```

Replace the example URL with a real repository. A local repository path refers
to the selected host; only committed content is acquired. The initial checkout
is private, without a writable host bind or host credential files. A portable
origin is retained; access to a private remote from inside the workspace needs
explicit user configuration. DIM does not forward an SSH agent automatically.

Tool installation and repository setup are ordinary commands inside the
workspace. Put reusable setup in repository scripts. Checkout, home and private
Docker data persist across sessions and container recreation.

```bash
dim stop dev
dim start dev
dim restart dev
dim recreate dev
dim resources dev --cpus 4 --memory 8g --pids 4096
dim resources dev --cpus unlimited --memory unlimited --pids unlimited
```

Removing limits can recreate the container while preserving its data. Recreation
does not fetch a new source revision or reset the working tree. Use Git inside
the workspace for source updates. List/show distinguish persisted lifecycle
phase from the observed runtime status. Missing initialized data is an error;
DIM does not silently replace it with an empty volume.

`dim discard dev --yes` removes the workspace and its owned volumes. Export
needed data before discarding. Failed cleanup retains a record for retry and
does not remove resources whose ownership cannot be verified.

Common workspace commands also work under `dim workspace`; `list` accepts
`ls`. Record commands offer `--json`, while `exec` preserves stdin, stdout,
stderr and the command's exit status.

## Select a remote host

Install the same DIM source build and runtime prerequisites on the remote host
first. Configure ordinary SSH authentication and host-key verification, then:

```bash
dim host add devbox --ssh developer@devbox
dim host use devbox
dim doctor
dim create /srv/repositories/app dev
dim shell dev
dim --host local ls
dim host list
```

Workspaces, source paths, images and runtime operations belong to the selected
host. The client invokes DIM through SSH; there is no required public host
administration endpoint. `dim host use local` restores the default context.

## Optional managed integration

A prepared source bundle can also install managed services and integrations:

```bash
just install-local --with-managed
```

This explicit profile installs managed Git/workspace support and the bundled
DNS, External URLs and host mirror plugins, and activates their controller.
It does not provision a native Git/CI deployment or invent its credentials.
For a registry package set, the equivalent library selection is
`dim installer install core --with-managed`; plugins remain explicit installs.
Managed runtime images and base workspace images are distinct.

The optional control-plane deployment has its own installer command:

```bash
dim installer install control-plane --config /absolute/operator-config.json
```

Its private config, service roles, images and recovery behavior are described
in the [installer specification](../specs/14-installer-facade.md) and managed
package documentation. Ordinary workspaces continue to use Git directly.
Managed administration and managed workspace operations belong to
[`dim managed`](../../core/packages/managed/docs/cli.md).
