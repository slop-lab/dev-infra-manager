# Installer Facade

## Scope

`@slop-lab/dim-installer` exposes an executable also named `dim`. It is a thin
facade: it owns only the `installer` namespace and proxies everything else to a
separately installed `@slop-lab/dim-cli`. `@slop-lab/dim-cli` must not
implement `installer`, and the facade
must not duplicate `@slop-lab/dim-cli`'s command tree or reimplement its
behavior.

The published executable is a POSIX launcher. When Node.js 24 or 26 is on
`PATH`, it must run the facade with that executable. When no supported Node.js
is on `PATH` but `mise` is available, it must run the facade through `mise
exec node@24` so Node.js need not be present in the global mise configuration.
When neither is available, it must fail with an actionable runtime error. This
bootstrap applies only to the facade; a direct-mode CLI symlink still requires
a supported Node.js on `PATH`.

## Command ownership

The facade owns:

```bash
dim installer                         # interactive installer (TTY only), always
dim installer install core [--host-mirror-plugin PACKAGE@EXACT_VERSION] [options]
dim installer install plugin PACKAGE@EXACT_VERSION...
dim installer enable-plugin PACKAGE...
dim installer disable-plugin PACKAGE...
dim installer remove-plugin PACKAGE...
```

`dim` with no arguments at all is an alias for `dim installer` only while no
CLI is configured; once one is, bare `dim` instead behaves like any other
command (see Dispatch) and proxies through, matching `dim --help`. This
keeps the ergonomic bare-word default useful for both a brand-new install
and an already-set-up one, without requiring an already-set-up user to type
`dim installer` explicitly just to avoid the wizard.

Repeated leading `installer` namespace tokens are accepted before the
installer command. Every other invocation, including `dim plugin ...` and
`dim install-cp` (`dim-cli` commands),
is forwarded unchanged.

## Dispatch

```text
no args, no CLI          -> interactive installer (TTY); non-TTY prints usage and exits 1
no args, CLI set          -> proxied to the configured executable (empty argv;
                            @slop-lab/dim-cli's own empty-argv behavior mirrors
                            its --help)
--help | -h               -> facade-only help when no CLI is configured;
                            otherwise the configured CLI's own --help, plus a
                            short footer naming the facade commands
--version | -V             -> "DIM installer <version>\nDIM CLI: not installed"
                            when no CLI is configured; otherwise
                            "DIM CLI <cli-version> (via DIM installer <installer-version>)",
                            with a non-fatal warning when the configured
                            version does not match the version the resolved
                            executable actually reports
anything else, no CLI     -> exit 2 with a message pointing at `installer install core`
anything else, CLI set    -> proxied to the configured executable
```

## Configuration

State lives at `$DIM_CONFIG_PATH`, defaulting to
`${XDG_CONFIG_HOME:-~/.config}/dim/config.json`, schema version 1:

```json
{
  "schemaVersion": 1,
  "cli": { "mode": "direct" | "proxied", "version": "0.9.0", "executable": "/abs/path" }
}
```

This file is shared with `@slop-lab/dim-cli` (for plugin discovery); both
readers must preserve unknown fields on write. This is a separate,
package-local config file, not the schema-versioned `DIM_STATE_ROOT` covered
by [Configuration](03-configuration.md).

Before proxying, the facade must verify the configured executable exists and
is executable, and must refuse to proxy to itself (comparing resolved real
paths) to avoid recursive execution. It must never search `PATH` for a `dim`
to fall back to.

## Install modes

Both modes install the DIM runtime—CLI, core, and enabled plugins—into one
private stable directory outside `PATH`:

```text
$XDG_DATA_HOME/dim/runtime/current/node_modules/.bin/dim
```

The installer prepares each replacement in a temporary sibling directory,
verifies its executable, and runs the staged target core package's read-only
state-compatibility preflight before promoting it to `current`. The preflight
uses `DIM_STATE_ROOT`, or the ordinary user-home default when it is unset, and
checks every existing core-owned host, Project, workspace, and CI-runner record
with that target package's parsers. It must use no currently installed CLI or
mutable source checkout, create no lifecycle object, lock, or state directory,
and perform no Docker, Git, or network operation. Plugin-private and otherwise
unknown state families are outside this contract and are ignored.

Known state files and recognized state-family directories must be inspected
without following symbolic links; known records must be regular files. Missing
state is compatible. Malformed or unsupported known state must stop installation
with the family, path, schema failure, and guidance to keep the old pinned DIM
version long enough to export needed data and recreate the resource. The error
must not print state contents. Refusal must leave the current runtime, facade,
user config, plugin activation, image state, and all state bytes unchanged;
temporary package staging is not installed state and must be removed.

The sole compatibility exception is a strict historical host schema-1 record
accepted by the target's existing schema-1 converter. The preflight only warns
that controller startup will perform the already-specified schema-1 to schema-2
migration; installation itself must not migrate it. No workspace, Project,
runner, or other state receives an automatic conversion, deletion, or
delete-and-recreate path.

For a registry installation on a host where the required host mirror plugin is
not already enabled, non-interactive `installer install core` must require
`--host-mirror-plugin @slop-lab/dim-plugin-host-mirrors@<installer-version>` and
reject every other package or version before npm or installed-state mutation.
With a TTY, omission must offer that same exact coordinate as a positive,
default-yes host-operator choice; declining must leave installed state
unchanged. This is installer facade host policy, not a Project, workspace,
capability-provider, or agent prompt. The installer must not select another
provider or silently install an unreviewed plugin.

The selected plugin must join the core and CLI in the same staged npm graph and
be recorded in staged `plugins.json` before promotion. After a successful
preflight, the installer promotes the staged runtime and
invokes the promoted CLI's `controller restart` subcommand exactly once. That
subcommand's controller readiness check is part of the installation
transaction. If restart/readiness or later configuration fails, the installer
must stop a target that already reached readiness before removing its runtime,
then restore the previous `current` directory and restart the prior controller
when one existed. Non-systemd shutdown must be a self-termination request over
the mode-`0600` host-admin Unix socket, followed by a bounded wait for socket
and PID-file cleanup. The controller must stop accepting on all listeners
immediately after flushing the stop response, give active requests a bounded
grace period, close all remaining HTTP connections including incomplete
requests, cancel active command sessions, and bound plugin disposal. If target
shutdown fails, rollback must retain the promoted runtime and prior backup
without restoring one over the other, report the original installation error,
and retain the shutdown error as causal detail. The installer and CLI must not
signal a PID obtained from the filesystem, and the shutdown request must not be
exposed on TCP, workspace, or agent listeners. It must remove
temporary and backup directories after success. DIM
exposes no CLI version-selection or rollback contract.

**Direct** (`--local-bin`) additionally creates or replaces a symlink at
`<prefix>/bin/dim` (prefix defaults to `~/.local`) pointing at that
executable. The facade must only create, replace, or remove a path there if
it is already a symlink resolving inside its own managed runtime
directory; any other existing file or symlink is a conflict that stops
installation without modification. The installer does not infer ownership or
attempt migration from the contents of an unmanaged path.

**Proxied** (`--no-local-bin`) records only the absolute executable path in
config; it must not modify `PATH`.

Detecting an active `mise` environment selects `--no-local-bin` as the
default; every other environment defaults to `--local-bin`. An explicit
`--local-bin`/`--no-local-bin` flag always overrides the detected default.
Before the interactive installer offers direct mode in a detected mise
environment, it must warn that the symlink can shadow the mise shim, bypass
the installer facade, and decouple the invoked CLI from mise's selected
installer version. Interactive yes/no questions must phrase the recommended
mode positively and use `Y` as their displayed default, so repeatedly answering
`y` or pressing Enter preserves the environment-specific recommended mode.

`installer install core --local-packages PATH` must accept a schema-1 `packages.json`
bundle produced by the repository package script. It installs every tarball
except `@slop-lab/dim-installer` in one npm transaction and records the version
reported by the installed CLI. The normal direct/proxied selection still
applies; manifest versions do not select filesystem paths. The local-bundle-only
`--defer-controller-restart` option suppresses the core promotion restart so a
reviewed source installer can activate required plugins first. Other install
sources must reject that option. The source installer must perform exactly one
explicit controller restart after plugin activation before reporting success.

Plugins install into a temporary sibling copy of the same `runtime/current`
npm project and replace `current` only after npm and activation-manifest
validation succeed. Plugin packages
must declare the exact compatible `@slop-lab/dim-core` as a peer dependency so
npm rejects an incompatible host before activation. CLI replacement reinstalls
the enabled plugin set in staging and must succeed as one dependency graph
before promotion. `plugins.json` lives in `runtime/current`; no independent
plugin installation root or persisted `pluginHome` setting exists.
Local plugin tarballs are copied into `runtime/sources` before installation;
the runtime must not depend on the caller's source path remaining available.
Disabling a plugin removes it only from `plugins.json`; enabling requires an
installed direct dependency, and removal deletes both dependency and manifest
entry and prunes unreferenced managed tarballs.

## Proxy contract

When forwarding a command to the configured `@slop-lab/dim-cli`, the facade
must preserve argv (including everything after `--`), the current working
directory, stdio and TTY, the exit code, and process signals, and must add
exactly two environment variables:

```text
DIM_INVOKED_VIA_INSTALLER=1
DIM_INSTALLER_VERSION=<installer version>
```

`@slop-lab/dim-cli` may use these two variables only to adjust `--help`
display text (root help and a short per-subcommand footer). They must not
affect command dispatch, configuration resolution, credential handling,
JSON output, lifecycle behavior, or exit codes, and must produce
byte-identical output to unset when unset.

## Plugin installation

`dim installer install plugin` requires an installed CLI because plugins join its npm
project and npm must validate their core peer dependency against that runtime.
`installer enable-plugin`, `installer disable-plugin`, and `installer remove-plugin` provide recovery without
hand-editing the managed npm project or activation manifest.

## Verification

Required tests cover:

- facade-only vs. proxied `--help`/`--version` in both installed states,
  including the version-mismatch warning;
- bare `dim` opens the interactive installer only when no CLI is
  configured, and proxies through like any other command once one is;
- installation and plugin-lifecycle argument parsing, including conflicting
  `--local-bin`/`--no-local-bin`, exact required-host-plugin selection, TTY
  acceptance and refusal, non-TTY fail-closed behavior, and local package bundle
  validation;
- managed-symlink create, idempotent replace, and rejection of an
  unmanaged/foreign path at the same location;
- successful CLI replacement prunes old managed installation directories;
- unsupported and malformed known state refuse installation before runtime,
  config, facade, plugin, or symlink promotion and remain byte-identical;
- missing state and exact current schemas pass, while exact historical host
  schema 1 passes read-only with a controller-startup migration warning;
- local-package installation resolves the preflight from the staged bundle's
  core metadata and code rather than the old installed CLI;
- proxy argv/cwd/env/stdio/exit-code fidelity;
- stale config (missing executable, facade self-reference) surfaced as
  actionable errors, not silent fallback to a `PATH`-resolved `dim`;
- `dim plugin ...` never intercepted by the facade;
- local tarball sources survive deletion and CLI replacement, plugin
  enable/disable/remove changes both activation and installation state, and a
  peer dependency failure leaves the existing runtime usable;
- `mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` end to end against a
  disposable local npm registry (`just verify mise-install-smoke`), covering
  non-TTY refusal before mutation, same-version host-mirror activation before
  first readiness, the mise-detected `--no-local-bin` default, and an explicit
  `--local-bin` override.

`dim install-cp` belongs to `@slop-lab/dim-cli`, not the facade. It is reserved
for control-plane-only host installation of the native Git host and CI
scheduler/webhook services, never a separate web UI. Until reviewed deployment
inputs define service configuration, storage ownership, supervision,
readiness, and rollback for both service families, the command must fail closed
with an actionable missing-dependency error and must make no host change.
