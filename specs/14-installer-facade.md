# Installer Facade

## Scope

`@slop-lab/dim-installer` exposes an executable also named `dim`. It is a thin
facade: it owns exactly three commands and proxies everything else to a
separately installed `@slop-lab/dim-cli`. `@slop-lab/dim-cli` must not
implement `installer`, `install-cli`, or `install-plugin`, and the facade
must not duplicate `@slop-lab/dim-cli`'s command tree or reimplement its
behavior.

## Command ownership

The facade owns only:

```bash
dim installer                # interactive installer (TTY only), always
dim install-cli [options]
dim install-plugin [options] PACKAGE@EXACT_VERSION...
```

`dim` with no arguments at all is an alias for `dim installer` only while no
CLI is configured; once one is, bare `dim` instead behaves like any other
command (see Dispatch) and proxies through, matching `dim --help`. This
keeps the ergonomic bare-word default useful for both a brand-new install
and an already-set-up one, without requiring an already-set-up user to type
`dim installer` explicitly just to avoid the wizard.

Every other invocation, including `dim plugin ...` (a `dim-cli` command),
is forwarded unchanged. The facade must not reserve any other name,
including other `install-*` names, for future use.

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
  "cli": { "mode": "direct" | "proxied", "version": "0.3.0", "executable": "/abs/path" },
  "pluginHome": "/abs/path"
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

Both modes install `@slop-lab/dim-cli` into a private, versioned directory
outside `PATH`:

```text
$XDG_DATA_HOME/dim/cli/<version>/node_modules/.bin/dim
```

**Direct** (`--local-bin`) additionally creates or replaces a symlink at
`<prefix>/bin/dim` (prefix defaults to `~/.local`) pointing at that
executable. The facade must only create, replace, or remove a path there if
it is already a symlink resolving inside its own managed versioned
directory; any other existing file or symlink is a conflict that stops
installation without modification. This applies uniformly to unrecognized
files and to a pre-0.2 `dim` left at that path; there is no migration path
from 0.1.

**Proxied** (`--no-local-bin`) records only the absolute executable path in
config; it must not modify `PATH`.

Detecting an active `mise` environment selects `--no-local-bin` as the
default; every other environment defaults to `--local-bin`. An explicit
`--local-bin`/`--no-local-bin` flag always overrides the detected default.
Before the interactive installer offers direct mode in a detected mise
environment, it must warn that the symlink can shadow the mise shim, bypass
the installer facade, and decouple the invoked CLI from mise's selected
installer version.

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

`dim install-plugin` must succeed whether or not `@slop-lab/dim-cli` is
installed; if it isn't, the command still installs and enables the
plugin(s) but must warn that nothing can use them yet.

## Verification

Required tests cover:

- facade-only vs. proxied `--help`/`--version` in both installed states,
  including the version-mismatch warning;
- bare `dim` opens the interactive installer only when no CLI is
  configured, and proxies through like any other command once one is;
- `install-cli`/`install-plugin` argument parsing, including conflicting
  `--local-bin`/`--no-local-bin`;
- managed-symlink create, idempotent replace, and rejection of an
  unmanaged/foreign path at the same location (including a simulated 0.1
  `dim`);
- proxy argv/cwd/env/stdio/exit-code fidelity;
- stale config (missing executable, facade self-reference) surfaced as
  actionable errors, not silent fallback to a `PATH`-resolved `dim`;
- `dim plugin ...` never intercepted by the facade;
- `mise use -g 'npm:@slop-lab/dim-installer@<version>'` end to end against a
  disposable local npm registry (`just verify-mise-install-smoke`), covering
  the mise-detected `--no-local-bin` default and an explicit
  `--local-bin` override.
