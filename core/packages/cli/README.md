# @slop-lab/dim-cli

`dim` manages persistent Linux development workspaces around one reviewed,
native Git root. The current product is root-only and native-only: it does not
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
dim installer install core \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.10.0'
dim doctor
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
dim ci native-root host run /absolute/operator/ordinary-host.json
dim ci native-qemu scheduler image build registry.example/dim-native-qemu-scheduler:0.10.0
dim ci native-qemu runner image build registry.example/dim-native-qemu-runner:0.10.0
dim ci native-qemu scheduler run /absolute/operator/qemu-scheduler.json
dim ci native-qemu host run qemu-a /absolute/operator/qemu-host.json
dim ci native-qemu event status EVENT_ID /absolute/operator/qemu-scheduler.json
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
dim project bootstrap-native-root demo \
  --project-id demo-root \
  --source-repository "$PWD/project-root" \
  --source-ref refs/heads/main \
  --registrar-connection /absolute/operator/registrar.json \
  --importer-connection /absolute/operator/importer.json \
  --json

export DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=/absolute/operator/control-plane.json
export DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE=/absolute/operator/importer.json
dim project create demo --json
dim project list --json
dim project show demo --json
```

`project create` publishes readiness only after fresh native service proof and
protected-root materialization. It neither runs CI nor creates approval.

```bash
dim workspace image build
dim workspace image status --json
dim create demo work-1
dim ls --json
dim show work-1 --json
dim run work-1 shell
dim run work-1 exec -- git status
dim exec work-1 -- git log -1 --oneline
dim resources work-1 --cpus 4 --memory 8g --pids 4096
dim stop work-1
dim start work-1
dim restart work-1
dim update work-1
dim setup work-1
dim discard work-1 --yes
```

`dim ls` (or `dim list`) lists workspaces. Common workspace operations are
available directly under `dim`; the `dim workspace` group exposes the same
commands for discoverability, plus local workspace image management. Both
forms use the same options and execution path.

Each workspace receives one immutable protected-root snapshot and a brokered
native Git endpoint. Its writer may create or fast-forward only its own
proposal namespace. Protected writes, deletes, force pushes, tags, foreign
workspace namespaces, and foreign Projects are rejected before mutation.

## Host lifecycle

```bash
dim host status --json
dim host shutdown
dim host start
```

`shutdown` preserves managed volumes and leaves the controller available.
`start` restores only the runtimes selected by the durable host lifecycle
record. There are no `host stop` or `host restart` commands.

## State compatibility

DIM is pre-stable. Current Project schema 6 and workspace schema 9 are strict.
Predecessor provider, repository, runner, and workspace state is rejected and
never adopted, migrated, renamed, or deleted. Use the pinned prior release to
export needed data, then create fresh native state.

See the repository's native [CLI contract](../../../specification/specs/10-cli-contract.md)
and [workspace guide](../../../specification/docs/project-workspaces.md).
