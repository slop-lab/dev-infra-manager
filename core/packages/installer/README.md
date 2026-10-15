# @slop-lab/dim-installer

`@slop-lab/dim-installer` is the pinned installer and facade for
`@slop-lab/dim-cli`. Its executable is also `dim`. It installs exact package
versions without `sudo`; commands outside the installer namespace are
forwarded unchanged to the installed CLI.

DIM supports Linux hosts only. Pin and review one exact release:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.9.0'
dim installer install core \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'
```

The equivalent one-shot form is:

```bash
npx '@slop-lab/dim-installer@0.9.0' installer install core \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'
```

## Commands

```text
dim installer
dim installer install core [--local-bin|--no-local-bin] [--prefix PATH]
  --host-mirror-plugin PACKAGE@EXACT_VERSION
dim installer install control-plane --config ABSOLUTE_FILE
dim installer recover control-plane --roll-forward --generation GENERATION
dim installer install plugin PACKAGE@EXACT_VERSION...
dim installer enable-plugin PACKAGE...
dim installer disable-plugin PACKAGE...
dim installer remove-plugin PACKAGE...
```

Bare `dim installer` is interactive only on a TTY. Once a CLI is installed,
all non-installer commands are forwarded to that exact CLI. The obsolete
`install-cp` token is rejected rather than aliased or forwarded.

## Core installation

The installer stages a complete candidate runtime, validates its package and
plugin graph, runs the candidate core's read-only compatibility preflight, and
only then promotes it. A required host-mirror plugin is selected by the trusted
operator, never by Project or agent input.

`--no-local-bin` keeps `dim` behind the mise/facade path. `--local-bin` manages
one symlink below the selected prefix. The installer refuses to overwrite any
file or symlink it does not own. Registry installs must use the installer's
exact version; ranges and `latest` are not accepted.

## Native control plane

The native Git schema-7 source may include its optional `qemuCi` dependency
for a separately deployed native QEMU scheduler. The installer validates its
service identity and HTTP(S) origin, includes all six role credentials in
cross-role collision checks and diagnostic secret redaction, and leaves
scheduler deployment to the operator.

```bash
dim installer install control-plane --config /absolute/operator/install.json
```

The configuration must be an absolute, owner-only strict file. Installation
publishes a digest-pinned native Git and ordinary-CI service generation, proves
its topology and readiness, then activates ordinary CI before native Git. The
services start empty and idle.

This command does not create Projects or repositories, advertise execution
capacity, run jobs, approve reviews, promote refs, install a reviewer UI, or
install native QEMU. Ordinary Sysbox hosts and native QEMU scheduler/runner
hosts are separate global deployments through the installed CLI.

If candidate activation is uncertain, the installer retains the exact
generation and requires explicit roll-forward recovery:

```bash
dim installer recover control-plane \
  --roll-forward \
  --generation aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Recovery accepts only the journaled generation and immutable published bytes.
It has no rollback, cleanup, repair, or alternate-generation mode.

## Compatibility boundary

Before changing the runtime, the candidate parser inspects only canonical DIM
state. Current root-only native Project and workspace records proceed. Obsolete
provider, repository, Project-scoped runner, ordinary-pool, and shared-QEMU
state is rejected unchanged. The installer does not adopt, reinterpret,
migrate, stop, delete, or rename predecessor containers, volumes, remotes,
credentials, or databases.

Use the pinned prior release to stop predecessor services and export needed
user data. Validate that export outside DIM state, install fresh native state,
and restore only declared user data. Disposal of old resources is a separate
explicit operator action.

## Plugins

Plugin coordinates must be exact versions. Local tarballs are copied into
installer-owned storage so replacement does not depend on the original path.
Installed plugins share the runtime's exact `@slop-lab/dim-core` and are
validated before activation.

Installer configuration is stored below
`${XDG_CONFIG_HOME:-$HOME/.config}/dim`; runtime data is below
`${XDG_DATA_HOME:-$HOME/.local/share}/dim`. Treat both as trusted host state.

See the normative [installer contract](../../../specification/specs/14-installer-facade.md)
and [adoption guide](../../../specification/docs/adoption.md).
