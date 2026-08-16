# @slop-lab/dim-installer

`@slop-lab/dim-installer` is a thin installer/facade for the real DIM CLI,
[`@slop-lab/dim-cli`](https://www.npmjs.com/package/@slop-lab/dim-cli). Its own
executable is also named `dim`. It installs the CLI and plugins with exact
versions via `npm`, requires no `sudo`, and does not duplicate DIM's command
tree: anything other than its three installer-owned commands is forwarded
as-is to the installed DIM CLI.

DIM installs and runs on Linux hosts only. macOS, Windows, and Docker Desktop
hosts are not supported.

## Getting the `dim` command

Two supported ways to run it, both pinned to an exact version:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.7.0'
dim install-cli
```

```bash
npx '@slop-lab/dim-installer@0.7.0' install-cli
```

With `mise`, plain `dim ...` keeps working afterwards for both installer
commands and (once installed) the real CLI. With `npx`, repeat the pinned
`npx '@slop-lab/dim-installer@0.7.0' ...` invocation each time you need the
installer.

The mise-installed facade uses an existing supported Node.js 24 or 26 when
one is on `PATH`. Otherwise it runs itself through `mise exec node@24`, which
installs Node.js 24 on demand without adding it to the global mise
configuration. Consequently, the first `dim` invocation may require network
access and take longer while Node.js is downloaded. A direct `--local-bin`
CLI symlink bypasses this facade bootstrap and still requires Node.js 24 or
26 on `PATH`.

Never use `latest` for software that controls development containers or
loads executable plugins — always pin an exact, reviewed version.

> Current `mise` releases ask for confirmation when an npm package is below
> aube's weekly-download threshold. Use `--raw` as shown above: without it,
> mise may hide the confirmation prompt and leave no way to enter `Y`. Review
> the exact pinned DIM release, then approve that direct package when prompted.
> The approval does not exempt low-download transitive dependencies.

### Losing access to the installer

If you install the CLI in direct-PATH mode (see below), `~/.local/bin/dim`
becomes a symlink straight to the real DIM CLI. Once that `dim` is the one
your shell resolves first, bare `dim` runs the real CLI directly — the
facade, and with it `dim installer` / `dim install-cli` / `dim install-plugin`,
is no longer reachable that way. To run installer-only commands again
(upgrading, adding a plugin, repairing), go back to an explicit, pinned
`npx` call:

```bash
npx '@slop-lab/dim-installer@0.7.0' install-cli
npx '@slop-lab/dim-installer@0.7.0' install-plugin '@example/dim-plugin@1.2.3'
```

If both a mise-provided facade and a direct-PATH `dim` are on `PATH`, normal
`PATH` order decides which one runs; use `which -a dim` to check. In
particular, `~/.local/bin/dim` may shadow mise's shim. That direct symlink
runs the CLI without the installer facade, so installer commands are no
longer available through that `dim`, and changing the version selected by
mise does not change the directly linked CLI. Keep the mise default (`N` /
`--no-local-bin`) unless that separation is intentional.

## Commands

The installer owns exactly three root commands. Everything else is passed
through unchanged to the installed DIM CLI (for example `dim plugin ...` is
always a DIM CLI command, never handled here).

```text
dim installer                Open the interactive installer (TTY only)
dim install-cli [options]    Install/upgrade the DIM CLI
dim install-plugin [options] PACKAGE@EXACT_VERSION...
                              Install and enable one or more plugins
```

Bare `dim` (no arguments) is an alias for `dim installer` only while no DIM
CLI is configured yet. Once one is, bare `dim` behaves like every other
command instead — it's forwarded to the installed CLI, which prints the same
thing as `dim --help`. This keeps `dim installer` as the one way to reopen
the installer prompt after that point.

Running `dim installer` with no TTY does not hang waiting for input — it
prints usage and exits with an error instead.

### Interactive install

```bash
npx '@slop-lab/dim-installer@0.7.0'
```

Prompts for what to install (CLI, plugin(s), or both), then — for the CLI —
whether to expose a `~/.local/bin/dim` symlink, and — for plugins — the
plugin home and space-separated, exact-version package specifiers.

### `dim install-cli`

```text
Usage: dim install-cli [options]

Options:
  --no-local-bin  Install privately for facade use without ~/.local/bin/dim
  --local-bin     Create a managed dim symlink in the user bin directory
  --prefix PATH   Use PATH/bin for the managed symlink (default: ~/.local)
  -h, --help      Show this help
```

`--local-bin` and `--no-local-bin` are mutually exclusive. See "CLI install
modes" below for what each one does and which is the default.

### `dim install-plugin`

```text
Usage: dim install-plugin [options] PACKAGE@EXACT_VERSION...

Options:
  --plugin-home PATH  Override the plugin installation directory
  -h, --help          Show this help
```

```bash
dim install-plugin '@example/dim-plugin@1.2.3'
dim install-plugin --plugin-home "$HOME/.local/share/dim/plugins" '@example/dim-plugin@1.2.3'
```

Specifiers must be pinned to an exact version (`name@x.y.z`); this command
does not resolve `latest` or ranges. Installed packages are recorded in
`plugins.json` under the plugin home. If the DIM CLI is not installed yet,
the command still installs and enables the plugin(s), but prints a warning
that there is no CLI yet to use them.

## CLI install modes

Either mode installs the real `@slop-lab/dim-cli` package into a private,
versioned data directory that is never on `PATH` directly:

```text
$XDG_DATA_HOME/dim/cli/0.7.0/node_modules/.bin/dim
```

(falling back to `~/.local/share/dim/cli/0.7.0/...` when `XDG_DATA_HOME` is
unset). The installed version matches the installer's own version.

**Direct PATH (`--local-bin`)** additionally creates or replaces a symlink
in the bin directory pointing at that versioned executable:

```text
~/.local/bin/dim -> $XDG_DATA_HOME/dim/cli/0.7.0/node_modules/.bin/dim
```

Use `--prefix PATH` to use `PATH/bin/dim` instead of `~/.local/bin/dim`. Once
this symlink is what `PATH` resolves, `dim` runs the real CLI directly and
the facade/installer commands are no longer reached that way (see above).

The installer only ever creates, replaces, or removes a `dim` at that path
if it is already a symlink pointing inside its own managed versioned data
directory. If some other file or symlink is already there — including a
different `dim` installation — it stops with a conflict error instead of
overwriting it; inspect and clean up the existing path yourself, then re-run.

**Proxied (`--no-local-bin`)** installs to the same versioned directory but
does not touch `PATH` at all. The facade instead records the absolute
executable path in its config and proxies every non-installer command to it.

```bash
dim install-cli --no-local-bin
```

**Default**: under `mise`, `--no-local-bin` is the default; everywhere else,
`--local-bin` is the default. The explicit flag always wins over this
detection. The interactive installer prints the direct-mode risks before it
offers `--local-bin` behavior under mise.

## `dim --help` / `dim --version`

Behavior depends on whether the real CLI is installed (per the facade's
config, not just `PATH`):

- **Not installed**: `dim --help` prints facade-only help (this package's own
  usage, not a pretend DIM CLI help). `dim --version` prints:
  ```text
  DIM installer 0.7.0
  DIM CLI: not installed
  ```
- **Installed**: `dim --help` is forwarded to the real CLI's own `--help`.
  `dim --version` prints:
  ```text
  DIM CLI 0.7.0 (via DIM installer 0.7.0)
  ```
  with a warning if the configured version no longer matches what's actually
  installed (run `dim install-cli` again to repair).

Any other command with no CLI installed fails fast with exit code 2 and a
message pointing at `dim install-cli`, instead of guessing at some other
`dim` on `PATH`.

## Configuration file

Installer state (proxied CLI executable path/version, plugin home) is kept
in:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/dim/config.json
```

or the path given by `DIM_CONFIG_PATH`. This file is also read by the DIM
CLI itself (for example to locate the plugin home), so treat it as shared
state rather than installer-private cache. You normally don't need to edit
it by hand — re-run `dim install-cli` / `dim install-plugin` to change what
it points at.

## What this does not do

The installer only installs the DIM CLI and DIM plugins. It does not install
Docker, a workspace runtime backend, or the DIM workspace image; see the
repository's
[host setup guide](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/usage.md)
for those prerequisites.

Before adopting DIM or any plugin, follow the mandatory
[adoption and trust requirements](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/adoption.md).
See the
[plugin documentation](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/plugins.md)
and
[`@slop-lab/dim-cli`](https://www.npmjs.com/package/@slop-lab/dim-cli)
for the next steps.
