# @slop-lab/dim-installer

`@slop-lab/dim-installer` is the pinned installer and facade for
`@slop-lab/dim-cli`. Its executable is also `dim`. It installs exact package
versions without `sudo`. Presentation commands use the separately installed CLI;
the frozen `dim __host` transport enters the host runtime directly, even without a CLI.

DIM supports Linux hosts only. Pin and review one exact release:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.10.0'
dim installer install core
```

The equivalent one-shot form is:

```bash
npx '@slop-lab/dim-installer@0.10.0' installer install core
```

## Commands

```text
dim installer
dim installer install core [--local-bin|--no-local-bin] [--prefix PATH]
  [--with-managed] [--host-mirror-plugin PACKAGE@EXACT_VERSION]
dim installer install cli [--local-packages DIRECTORY] [--local-bin|--no-local-bin]
dim installer install control-plane --config ABSOLUTE_FILE
dim installer recover control-plane --roll-forward --generation GENERATION
dim installer install plugin [--local-packages DIRECTORY] PACKAGE@EXACT_VERSION...
dim installer enable-plugin PACKAGE...
dim installer disable-plugin PACKAGE...
dim installer remove-plugin PACKAGE...
```

Bare `dim installer` is interactive only on a TTY. Once a CLI is installed,
presentation commands replace the facade process with that exact CLI, preserving
the process identity, terminal streams and signals without retaining an idle
installer parent. Installer implementation modules are loaded only for the
installer namespace. The obsolete
`install-cp` token is rejected rather than aliased or forwarded.

## Core installation

The installer stages a complete candidate runtime, validates its package and
plugin graph, runs the candidate core's read-only compatibility preflight, and
only then promotes it. Base installation requires no control plane, mirror
plugin, configured container backend, or running controller. It installs the
host runtime without starting a controller service. It bootstraps a missing presentation
CLI into a separate prefix; subsequent host updates retain that CLI.
`dim installer install cli` updates only the CLI and never restarts the controller.
Both executables advertise supported CLI–host protocol versions; independent
releases are accepted when they share a protocol version. An incompatible candidate
is rejected before promotion. An already active owned controller
is restarted against the candidate runtime; failed readiness restores the
previous runtime and controller. Generic controller functionality belongs to
host core and is available in the base installation. Separate control-plane
containers are untouched. Plugin installation follows the same activation rule.

Workspace cache clients are optional. To select the reviewed client explicitly:

```bash
dim installer install core \
  --host-mirror-plugin '@slop-lab/dim-host-plugin-mirrors@0.10.0'
```

This selects the client only; installation does not provision caches or require
cache URLs. Before using the selected client, either configure reviewed endpoint
URLs with `dim mirrors configure FILE`, or install and explicitly start the
independent server plugin on this host:

```bash
dim installer install plugin '@slop-lab/dim-host-plugin-cache-server@0.10.0'
dim cache-server ensure
dim mirrors ensure
```

The server publishes a host-local URL catalog consumed by the client. For a
separate cache host, copy its reviewed endpoint catalog to the workspace host
and run `dim mirrors configure FILE`; use addresses reachable from that host.
Installing either plugin never starts cache services. Base installation does
not select either package.

Already enabled official host plugins are updated to the target host release
during core installation; independently versioned third-party plugin pins are retained. A fresh install does not select it or prompt
for it. Project and agent input cannot select host installation dependencies.

Managed Git, review and shared CI are also optional:

```bash
dim installer install core --with-managed
```

This selects the exact-version Native Git and execution worker host plugins together
with control-plane operator tools. It does not deploy a control plane. Later
core installations retain selected operator tools and enabled plugins.
Local package bundles declare the exact
dependency graph in `packages.json`; host and CLI installation select separate
artifact closures and prefixes. `--with-managed` selects those host plugins and operator tools. Previously enabled plugins remain selected and
use matched bundle artifacts. Missing or mismatched selected dependencies fail
before package installation instead of falling back to a registry.

Repository source installation installs the complete development profile:

```bash
bash scripts/install-source-build.bash
bash scripts/install-source-build.bash --with-managed
```

Both forms select all prepared host and control-plane plugins, operator tools
and local services; `--with-managed` is accepted for convenience. They update the host
first, then explicitly update the separate CLI. Host plugins use their matched
host-core peer. The published installer keeps optional components opt-in.

These repository-only source commands also install a separate matched Web UI
runtime and configure local host access. With user systemd they enable
`dim-web.service` on `http://127.0.0.1:9081`. The initial browser login is stored
privately in `~/.config/dim/web/login.txt`; later installs preserve it. This setup
is not part of the published `installer install core` command. See the
[source usage guide](../../docs/guides/usage.md#install-development-sources).

`--no-local-bin` keeps `dim` behind the mise/facade path. `--local-bin` manages
one symlink below the selected prefix. The installer refuses to overwrite any
file or symlink it does not own. Registry installs must use the installer's
exact version; ranges and `latest` are not accepted.

## Native control plane

For private deployment configuration and host connections, use
`dim control-plane prepare` and `connect` from
`@slop-lab/dim-control-plane-admin`; see the
[Native Git guide](../host/plugins/native-git/docs/cli.md). A deployment host
running only control-plane services needs the installer facade and reviewed
configuration files. It does not need the workspace CLI or host core.

```bash
dim installer install control-plane --config /absolute/operator/install.json
```

The configuration must be an absolute, owner-only strict file. Installation
publishes a digest-pinned native Git and execution scheduler service generation, proves
its topology and readiness, then activates ordinary CI before native Git. The
services start empty and idle.

This command does not create Projects or repositories, advertise execution
capacity, run jobs, approve reviews, promote refs, install a reviewer UI, or
install native QEMU. CI worker capacity is provided explicitly by the host execution worker plugin, with
configured Sysbox or QEMU/KVM slots.

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

Before changing the runtime, the candidate parser validates current standalone
workspace records. Unsupported workspace state is rejected unchanged. Optional
integrations own validation of their state. The installer does not adopt,
reinterpret, migrate, stop, delete, or rename predecessor containers, volumes,
remotes, credentials, or databases.

Use the pinned prior release to stop predecessor services and export needed
user data. Validate that export outside DIM state, install fresh workspace state,
and restore only declared user data. Disposal of old resources is a separate
explicit operator action.

## Plugins

For a matched source bundle, use `--local-packages DIRECTORY` with exact plugin
versions on either host or control-plane installs. The installer selects the
complete declared dependency closure from `packages.json`; it enables only the
requested plugins. A host bundle must match the installed host version; the CLI may have a different release. The
artifact directory can contain other optional packages without selecting them.

Plugin coordinates must be exact versions. Local tarballs are copied into
installer-owned storage so replacement does not depend on the original path.
Host plugins share the runtime's exact `@slop-lab/dim-host-core` and are
validated before activation. Control-plane plugins use their separate runtime.

Installer configuration is stored below
`${XDG_CONFIG_HOME:-$HOME/.config}/dim`; runtime data is below
`${XDG_DATA_HOME:-$HOME/.local/share}/dim`. The host prefix is `runtime/current`;
the independently updated presentation prefix is `cli/runtime/current`. Treat both as trusted host state.

See the normative [installer contract](../../docs/specs/14-installer-facade.md)
and [adoption guide](../../docs/guides/adoption.md).
