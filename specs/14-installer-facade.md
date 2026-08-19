# Installer Facade

## Scope

`@slop-lab/dim-installer` exposes an executable also named `dim`. It is a thin
facade: it owns installation and installed-plugin lifecycle commands and proxies everything else to a
separately installed `@slop-lab/dim-cli`. `@slop-lab/dim-cli` must not
implement `installer`, `install-cli`, `install-plugin`, `enable-plugin`,
`disable-plugin`, or `remove-plugin`, and the facade
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
dim installer                # interactive installer (TTY only), always
dim install-cli [options]
dim install-plugin PACKAGE@EXACT_VERSION...
dim enable-plugin PACKAGE...
dim disable-plugin PACKAGE...
dim remove-plugin PACKAGE...
```

`dim` with no arguments at all is an alias for `dim installer` only while no
CLI is configured; once one is, bare `dim` instead behaves like any other
command (see Dispatch) and proxies through, matching `dim --help`. This
keeps the ergonomic bare-word default useful for both a brand-new install
and an already-set-up one, without requiring an already-set-up user to type
`dim installer` explicitly just to avoid the wizard.

Every other invocation, including `dim plugin ...` (a `dim-cli` command),
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
anything else, no CLI     -> exit 2 with a message pointing at `install-cli`
anything else, CLI set    -> proxied to the configured executable
```

## Configuration

State lives at `$DIM_CONFIG_PATH`, defaulting to
`${XDG_CONFIG_HOME:-~/.config}/dim/config.json`, schema version 1:

```json
{
  "schemaVersion": 1,
  "cli": { "mode": "direct" | "proxied", "version": "0.7.0", "executable": "/abs/path" }
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
verifies its executable, and then promotes it to `current`. It must restore the
previous `current` directory when promotion or configuration fails, and remove
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

`install-cli --local-packages PATH` must accept a schema-1 `packages.json`
bundle produced by the repository package script. It installs every tarball
except `@slop-lab/dim-installer` in one npm transaction and records the version
reported by the installed CLI. The normal direct/proxied selection still
applies; manifest versions do not select filesystem paths.

Plugins install into the same `runtime/current` npm project. Plugin packages
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

`dim install-plugin` requires an installed CLI because plugins join its npm
project and npm must validate their core peer dependency against that runtime.
`enable-plugin`, `disable-plugin`, and `remove-plugin` provide recovery without
hand-editing the managed npm project or activation manifest.

## Verification

Required tests cover:

- facade-only vs. proxied `--help`/`--version` in both installed states,
  including the version-mismatch warning;
- bare `dim` opens the interactive installer only when no CLI is
  configured, and proxies through like any other command once one is;
- installation and plugin-lifecycle argument parsing, including conflicting
  `--local-bin`/`--no-local-bin`, and local package bundle validation;
- managed-symlink create, idempotent replace, and rejection of an
  unmanaged/foreign path at the same location;
- successful CLI replacement prunes old managed installation directories;
- proxy argv/cwd/env/stdio/exit-code fidelity;
- stale config (missing executable, facade self-reference) surfaced as
  actionable errors, not silent fallback to a `PATH`-resolved `dim`;
- `dim plugin ...` never intercepted by the facade;
- local tarball sources survive deletion and CLI replacement, plugin
  enable/disable/remove changes both activation and installation state, and a
  peer dependency failure leaves the existing runtime usable;
- `mise use --raw --global 'npm:@slop-lab/dim-installer@<version>'` end to end against a
  disposable local npm registry (`just verify-mise-install-smoke`), covering
  the mise-detected `--no-local-bin` default and an explicit
  `--local-bin` override.
