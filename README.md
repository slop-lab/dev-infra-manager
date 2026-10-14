# dev-infra-manager

DIM provides persistent, isolated Linux workspaces backed by one native Git
control plane. A Project has one reviewed root repository, one protected root
ref, workspace-scoped proposal authority, optional global ordinary Sysbox and
native QEMU capacity, human review, and checked compare-and-swap promotion.

DIM does not embed or manage a forge, issue tracker, or Actions service. It
does not expose repository CRUD, Project removal/purge, or Project-scoped
runner APIs. Forge-specific tooling used to contribute to this repository is
development tooling, not a DIM runtime dependency.

## Trust path

```text
reviewed root -> native Project -> persistent workspace -> proposal ref
       -> candidate-controlled ordinary/QEMU evidence -> human approval
       -> checked protected-ref compare-and-swap
```

Project and workspace readiness do not depend on CI availability. Ordinary and
QEMU jobs are optional quality evidence selected by the protected root policy.
Their success proves only that candidate-selected tests ran under the recorded
operator bounds. It is not independent verification and cannot replace human
approval or the final compare-and-swap.

## Install

DIM is pre-stable and part of the host trust boundary. Pin and review one exact
release or complete source commit.

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.9.0'
dim installer install core \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'
dim doctor
```

Install the native Git and ordinary-CI service bundle from one caller-owned,
absolute, mode-`0600` configuration:

```bash
dim installer install control-plane --config /absolute/operator/install.json
```

Native ordinary and QEMU execution are separately deployed global host
services. They are not created per Project:

```bash
dim ci native-root host run /absolute/operator/ordinary-host.json
dim ci native-qemu scheduler image build registry.example/dim-native-qemu-scheduler:0.9.0
dim ci native-qemu runner image build registry.example/dim-native-qemu-runner:0.9.0
dim ci native-qemu scheduler run /absolute/operator/qemu-scheduler.json
dim ci native-qemu host run qemu-a /absolute/operator/qemu-host.json
```

The ordinary host requires `sysbox-runc` and the enabled exact-version host
mirror plugin installed above; it reconciles the owned pull-through cache and
control network before serving capacity. The QEMU host requires a real,
accessible `/dev/kvm`; TCG is never accepted as KVM evidence.

## Create a native Project

Bootstrap only from an already-local reviewed repository and one full branch
ref. Registrar and importer roles are distinct private files.

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

`create` publishes `ready` only after live native proof, protected-root
snapshot validation, proposal-only writer authority, and local workspace
runtime prerequisites. It never starts CI or creates approval.

## Use a workspace

```bash
dim workspace create demo work-1
dim workspace show work-1 --json
dim workspace run work-1 shell
dim workspace run work-1 exec -- git status
dim workspace exec work-1 -- git log -1 --oneline
dim workspace stop work-1
dim workspace start work-1
dim workspace restart work-1
dim workspace update work-1
dim workspace discard work-1 --yes
```

The workspace receives a protected-root snapshot and a brokered Git endpoint.
Its writer can create or fast-forward only its own proposal namespace. Direct
protected writes, deletes, force pushes, tags, foreign workspace namespaces,
and foreign Projects are denied.

## Existing installations

DIM does not migrate, reinterpret, adopt, delete, or rename predecessor
Project, repository, runner, container, volume, or remote state. Before
installing this native-only product, use the pinned prior release to stop its
services and export required user data. Validate the export outside DIM state,
then create fresh native state and restore only declared user data.

Do not delete existing forge containers, volumes, remotes, or credentials as a
side effect of native installation. Their explicit operator disposal is a
separate action after export and validation.

## Verification

```bash
just check-source-native
just verify native-idle-service-images
just verify control-plane-install-live
just verify native-basic-lifecycle
just verify native-ordinary-guest-mechanics
just verify native-qemu-guest-mechanics-kvm
```

The last two commands prove same-host execution mechanics. They do not satisfy
independent-host or human release acceptance. The disposable KVM guest
aggregate is `verification/scripts/kvm-guest-verification-smoke.bash`; it emits
per-phase `PASS`, `FAIL`, or `BLOCKED` records and reserves exit `125` for
uncertain cleanup. Missing hardware is unavailable, never a pass.

See [the documentation index](specification/docs/README.md), the
[CLI contract](specification/specs/10-cli-contract.md), and the
[verification contract](specification/specs/12-verification.md).
