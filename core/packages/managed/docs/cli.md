# Managed administration CLI

`dim managed` administers the optional managed Git, review and CI component
provided by `@slop-lab/dim-managed`. This component uses one reviewed native
Git root; ordinary Git workspaces do not need it. It does not
embed Gitea, expose repository CRUD, remove Projects, or create Project-scoped
CI runners.

## Requirements

- Linux with a systemd user manager
- Node.js 24 or 26
- Git, Docker with Compose v2 and Buildx, and `sysbox-runc`
- real, accessible `/dev/kvm` for optional native QEMU capacity

Pin the CLI to the same reviewed version as the installer and plugins. The
recommended installation is through `@slop-lab/dim-installer`:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
dim installer install core --with-managed \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.10.0'
dim managed doctor
```

## Native control plane

Install the empty native Git and ordinary-CI service bundle from one absolute,
owner-only configuration file:

```bash
dim installer install control-plane --config /absolute/operator/install.json
```

The installer does not create Projects, approvals, execution capacity, or a
reviewer UI. Start global ordinary and QEMU capacity separately:

```bash
dim managed ci native-root host run /absolute/operator/ordinary-host.json
dim managed ci native-qemu scheduler image build registry.example/dim-native-qemu-scheduler:0.10.0
dim managed ci native-qemu runner image build registry.example/dim-native-qemu-runner:0.10.0
dim managed ci native-qemu scheduler run /absolute/operator/qemu-scheduler.json
dim managed ci native-qemu host run qemu-a /absolute/operator/qemu-host.json
dim managed ci native-qemu event status EVENT_ID /absolute/operator/qemu-scheduler.json
```

These long-running commands consume fixed operator configuration. Candidate
bytes cannot choose credentials, images, bounds, mounts, networks, or fallback
executors. The ordinary host loads the enabled exact-version host mirror plugin
and reconciles DIM-owned cache and control-network resources before it locks
capacity. QEMU execution requires KVM; there is no TCG or ordinary fallback.

## Projects and workspaces

Bootstrap one exact branch from an already-local reviewed repository through
separate registrar and importer roles:

```bash
dim managed project bootstrap-native-root demo \
  --project-id demo-root \
  --source-repository "$PWD/project-root" \
  --source-ref refs/heads/main \
  --registrar-connection /absolute/operator/registrar.json \
  --importer-connection /absolute/operator/importer.json \
  --json

export DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/absolute/operator/control-plane.json
export DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=/absolute/operator/importer.json
dim managed project create demo --json
dim managed project list --json
dim managed project show demo --json
```

`project create` publishes readiness only after fresh native service proof and
protected-root materialization. It neither runs CI nor creates approval.

```bash
dim managed workspace image build
dim managed workspace image status --json
dim managed create demo work-1
dim managed ls --json
dim managed show work-1 --json
dim managed run work-1 shell
dim managed run work-1 exec -- git status
dim managed exec work-1 -- git log -1 --oneline
dim managed resources work-1 --cpus 4 --memory 8g --pids 4096
dim managed stop work-1
dim managed start work-1
dim managed restart work-1
dim managed update work-1
dim managed setup work-1
dim managed discard work-1 --yes
```

`dim managed ls` (or `dim managed list`) lists workspaces. Common workspace operations are
available directly under `dim managed`; the `dim managed workspace` group exposes the same
commands for discoverability, plus local workspace image management. Both
forms use the same options and execution path.

Each workspace receives one immutable protected-root snapshot and a brokered
native Git endpoint. Its writer may create or fast-forward only its own
proposal namespace. Protected writes, deletes, force pushes, tags, foreign
workspace namespaces, and foreign Projects are rejected before mutation.

## Host lifecycle

```bash
dim managed host status --json
dim managed host shutdown
dim managed host start
```

`shutdown` preserves managed volumes and leaves the controller available.
`start` restores only the runtimes selected by the durable host lifecycle
record. There are no `host stop` or `host restart` commands.

## State compatibility

Managed Project and workspace state defaults to `~/.local/state/dim/managed`,
separate from ordinary workspaces. `DIM_MANAGED_STATE_ROOT` selects another
managed state directory. An explicitly supplied `DIM_STATE_ROOT` remains a
shared override when no managed-specific selection is present. Controller
sockets also use their own `dim/managed` runtime directory.

DIM is pre-stable. Current Project schema 6 and workspace schema 9 are strict.
Predecessor provider, repository, runner, and workspace state is rejected and
never adopted, migrated, renamed, or deleted. Use the pinned prior release to
export needed data, then create fresh native state.

See the repository's native [CLI contract](../../../../specification/specs/10-cli-contract.md)
and [workspace guide](../../../../specification/docs/project-workspaces.md).
