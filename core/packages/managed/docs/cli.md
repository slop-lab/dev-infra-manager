# Managed administration CLI

`dim managed` provides optional native Git, Project review and CI administration.
Ordinary Git workspaces use the base CLI and do not need this package. Native
Projects attach to the same workspace runtime and lifecycle through `dim://`
sources.

## Installation

Install the reviewed version of the optional component alongside the CLI:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
dim installer install core --with-managed
dim doctor
```

Linux, Git, Docker and `sysbox-runc` are required for workspaces. Optional
control-plane services use Docker Compose and a systemd user manager. QEMU CI
requires accessible `/dev/kvm`. Mirror, DNS and external URL plugins are optional;
installing managed administration does not enable them or install a controller.

## Native control plane

Prepare private operator configuration from exact reviewed image digests, review
it, install the services, then connect to their live generation:

```bash
dim managed control-plane prepare "$HOME/dim-control-plane" \
  --native-git-image 'registry.example/dim-native-git@sha256:REVIEWED_DIGEST' \
  --ordinary-ci-image 'registry.example/dim-ordinary-ci@sha256:REVIEWED_DIGEST'
dim installer install control-plane --config "$HOME/dim-control-plane/install.json"
dim managed control-plane connect "$HOME/dim-control-plane"
```

`connect` attests each service role, writes private host, registrar, importer,
reviewer and promoter connections, and selects the host/importer files on this
host. Project and `dim://` workspace commands then need no environment exports.
Use `--output-directory NEW_DIRECTORY` when connecting a new service generation.
Existing native workspaces adopt that connection on their next start, restart,
recreate or shell/exec only after proving the same control-plane authority,
Project, protected ref and review policy. Their checkout and Git identity stay
unchanged. A connection to another authority cannot retarget an existing
workspace.

The generated files contain credentials; retain their owner-only permissions.

Selection belongs to the executing host. For `dim --host REMOTE create dim://demo
work-1`, run control-plane setup and connect on that remote host first. The local
client does not transfer its control-plane credentials. Explicit
`DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` and
`DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE` override the saved selection for an
individual process; their service, host and generation must agree.

The installer creates services, not Projects, approvals, CI capacity or reviewer
UI deployments.

## CI capacity

Start global ordinary and QEMU capacity separately:

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

Bootstrap an exact branch from an already-local reviewed repository through the
separate registrar and importer roles, then publish Project readiness:

```bash
dim managed project bootstrap-native-root demo \
  --project-id demo-root \
  --source-repository "$PWD/project-root" \
  --source-ref refs/heads/main \
  --registrar-connection "$HOME/dim-control-plane/connections/registrar.json" \
  --importer-connection "$HOME/dim-control-plane/connections/importer.json" \
  --json
dim managed project create demo --json
dim managed project list --json
dim managed project show demo --json
```

Project creation proves protected-root materialization and readiness. It does
not run CI or create approval. Create and operate its workspace with the base
commands:

```bash
dim image build
dim create dim://demo work-1
dim ls --json
dim show work-1 --json
dim shell work-1
dim exec work-1 -- git status
dim resources work-1 --cpus 4 --memory 8g --pids 4096
dim stop work-1
dim start work-1
dim recreate work-1
dim discard work-1 --yes
```

Each native attachment pins a protected-root snapshot and receives a brokered
Git endpoint for its own proposal namespace. Protected writes, deletes, force
pushes, tags, foreign workspace namespaces and foreign Projects are rejected.
Container recreation preserves workspace data. The base lifecycle owns both
ordinary Git and native Project workspaces; there is no separate managed
workspace creation, setup, image or host-global lifecycle command.

## Reviewer UI

The web package is an optional separate installation. Use its connection-bound
configuration rather than copying service credentials into browser code:

```bash
mise use --raw --global 'npm:@slop-lab/dim-web@0.10.0'
dim-reviewer-web init "$HOME/dim-control-plane/connections/reviewer.json" \
  --project demo-root --output "$HOME/dim-reviewer.json" --port 8789
dim-reviewer-web serve "$HOME/dim-reviewer.json"
```

Review approval and protected-ref promotion remain separate authority roles.

## Host state

Ordinary and native-attached workspace records share the base store under
`~/.local/state/dim`. `DIM_STATE_ROOT` selects another base store. Managed Project
records, pending imports, plugin configuration and the active control-plane
selection default to `~/.local/state/dim/managed`; `DIM_MANAGED_STATE_ROOT`
selects another managed directory. An explicit `DIM_STATE_ROOT` also supplies
the managed location when no managed-specific override is present.

Optional plugin administration uses `dim managed controller` and its host-owned
Unix sockets. Workspace-scoped requests use core workspace UUID grants and do
not expose a controller socket or runtime credentials inside containers.

DIM is pre-stable. Obsolete configuration and state are rejected instead of
being silently adopted. Export required data with the prior pinned version
before starting fresh.

See the [workspace guide](../../../../specification/docs/project-workspaces.md)
and [plugin guide](../../../../specification/docs/plugins.md).
