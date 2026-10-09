# @slop-lab/dim-installer

`@slop-lab/dim-installer` is a thin installer/facade for the real DIM CLI,
[`@slop-lab/dim-cli`](https://www.npmjs.com/package/@slop-lab/dim-cli). Its own
executable is also named `dim`. It installs the CLI and plugins with exact
versions via `npm`, requires no `sudo`, and does not duplicate DIM's command
tree: anything outside its installer-owned namespace is forwarded
as-is to the installed DIM CLI, except the obsolete `install-cp` token, which
the facade rejects rather than forwarding.

DIM installs and runs on Linux hosts only. macOS, Windows, and Docker Desktop
hosts are not supported.

## Getting the `dim` command

Two supported ways to run it, both pinned to an exact version:

```bash
mise use --raw --global 'npm:@slop-lab/dim-installer@0.9.0'
dim installer install core \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'
```

```bash
npx '@slop-lab/dim-installer@0.9.0' installer install core \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'
```

With `mise`, plain `dim ...` keeps working afterwards for both installer
commands and (once installed) the real CLI. With `npx`, repeat the pinned
`npx '@slop-lab/dim-installer@0.9.0' ...` invocation each time you need the
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
facade, and with it the `dim installer` namespace,
is no longer reachable that way. To run installer-only commands again
(upgrading, adding a plugin, repairing), go back to an explicit, pinned
`npx` call:

```bash
npx '@slop-lab/dim-installer@0.9.0' installer install core \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'
npx '@slop-lab/dim-installer@0.9.0' installer install plugin '@example/dim-plugin@1.2.3'
```

If both a mise-provided facade and a direct-PATH `dim` are on `PATH`, normal
`PATH` order decides which one runs; use `which -a dim` to check. In
particular, `~/.local/bin/dim` may shadow mise's shim. That direct symlink
runs the CLI without the installer facade, so installer commands are no
longer available through that `dim`, and changing the version selected by
mise does not change the directly linked CLI. Keep the mise-managed facade
default unless that separation is intentional.

## Commands

The installer owns installation and installed-plugin lifecycle commands. Everything else is passed
through unchanged to the installed DIM CLI (for example `dim plugin ...` is
always a DIM CLI command, never handled here).

```text
dim installer                Open the interactive installer (TTY only)
dim installer install core [options]
                              Install/upgrade DIM core and CLI
dim installer install control-plane --config FILE
                              Install/update the idle native control-plane bundle
dim installer recover control-plane --roll-forward --generation GENERATION
                              Complete one exact retained published generation
dim installer install plugin PACKAGE@EXACT_VERSION...
                              Install and enable one or more plugins
dim installer enable-plugin PACKAGE...
dim installer disable-plugin PACKAGE...
dim installer remove-plugin PACKAGE...
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
npx '@slop-lab/dim-installer@0.9.0'
```

Prompts for what to install (CLI, plugin(s), or both), then — for the CLI —
whether to expose a `~/.local/bin/dim` symlink, and — for plugins —
space-separated, exact-version package specifiers.

### `dim installer install core`

```text
Usage: dim installer install core [options]

Options:
  --no-local-bin  Install privately for facade use without ~/.local/bin/dim
  --local-bin     Create a managed dim symlink in the user bin directory
  --prefix PATH   Use PATH/bin for the managed symlink (default: ~/.local)
  --host-mirror-plugin PACKAGE@EXACT_VERSION
                  Install and enable the reviewed required host mirror plugin
  -h, --help      Show this help
```

`--local-bin` and `--no-local-bin` are mutually exclusive. See "CLI install
modes" below for what each one does and which is the default.

On a clean host, core installation also requires the reviewed host mirror
provider at the installer's exact version:

```bash
dim installer install core --no-local-bin \
  --host-mirror-plugin '@slop-lab/dim-plugin-host-mirrors@0.9.0'
```

When stdin and stdout are TTYs, omitting this option offers that exact
coordinate as a default-yes host-operator choice. Declining leaves the runtime
uninstalled. Without a TTY, omission fails before npm runs and prints the exact
option required. No Project, workspace, or agent input can make this choice or
select the plugin's digest-pinned images.

### `dim installer install control-plane`

```text
Usage: dim installer install control-plane --config FILE

Options:
  --config FILE  Read the control-plane installation configuration from FILE
  -h, --help     Show this help
```

`FILE` must be an absolute path to the strict, operator-owned control-plane
configuration. The command accepts exactly one `--config` and no positional,
unknown, or state-root options. Installed state is kept under
`${XDG_STATE_HOME:-$HOME/.local/state}/dim/control-plane`.

This pre-stable command installs or updates only the digest-pinned native Git
and ordinary-CI service bundle. The services start empty and idle. The command
does not create a Project or repository, admit a Project, advertise capacity,
run a Sysbox job, install a host controller, or install a reviewer browser UI.
Those capabilities require separate future contracts and acceptance gates.
`dim install-cp` is obsolete, is not a CLI alias, and is rejected by the facade
before configured-CLI forwarding.

Before it reads `FILE` or creates installer state, the command rejects presence
of the obsolete `DIM_ORDINARY_CI_POOL_CONNECTION_FILE` selector and scans only
canonical lifecycle records under
`${DIM_STATE_ROOT:-$HOME/.local/state/dim}/ci-runners/<project>/*.json`.
Project-scoped Sysbox records and unsafe or unclassifiable records fail closed
without modification. Valid schema-8 QEMU records are allowed and untouched.
The command does not search arbitrary filesystem paths or process tables for
old `dim ci ordinary-pool service run <config>` instances because that command
accepted arbitrary private config and database paths. Stop such external old
services with their pinned predecessor release. The new bundle never adopts an
old database or a pre-existing fixed ordinary-CI volume.

Before creating or replacing bundle resources, the installer uses disposable
containers in the selected Docker daemon to verify each newly selected
published address. This remains authoritative when a rootless daemon's
published ports are unreachable from the installer process namespace. An
occupied or indeterminate address fails closed without stopping, adopting, or
relabeling its owner. Exact unchanged bindings of a completely verified owned
installation are reused without a conflicting disposable probe.

The production installer invokes Docker only through a verified
`/usr/local/bin/docker` or `/usr/bin/docker`. The selected CLI and every parent
directory must be root-owned, non-symlinked, and not group- or world-writable;
the CLI must also be a regular executable file. Caller `PATH` and the current
working directory never select the Docker program. Docker subprocesses receive
a system-only `PATH` so credential helpers cannot be selected from a Project
checkout, while settings such as `DOCKER_HOST` remain available for rootless
daemons.

### `dim installer recover control-plane`

```text
Usage: dim installer recover control-plane --roll-forward --generation GENERATION

Options:
  --roll-forward           Complete the exact retained published generation
  --generation GENERATION  Require this canonical 64-character generation ID
  -h, --help               Show this help
```

Use this operator-invoked command only after installation reports that
candidate activation started but completion is uncertain. `GENERATION` must be
the exact retained candidate generation in `install.json`. Recovery does not
read mutable installer config and has no rollback, repair, cleanup, or
alternate-generation mode.

Recovery locks the existing state and requires the exact schema-1 `publishing`
journal, canonical transaction identity, published candidate record and Compose
bytes, and the journaled prior generation when present. Other retained
generation directories are validated as inert history, never selected for
activation; first-install recovery permits only its candidate. Before activation it verifies complete owned Docker
resources, exact candidate runtime topology, and both service readiness checks.
It then replays the candidate's mounted activation ordinary CI first and native
Git second, repeats state, topology, and readiness verification, and removes
only the byte-identical journal with directory durability. A wrong generation,
malformed or mixed state, missing or foreign resource, failed readiness, or
failed activation leaves the journal and retained resources untouched. Normal
`installer install control-plane` continues to refuse while the journal exists.

### `dim installer install plugin`

```text
Usage: dim installer install plugin PACKAGE@EXACT_VERSION...

Options:
  -h, --help  Show this help
```

```bash
dim installer install plugin '@example/dim-plugin@1.2.3'
```

Specifiers must be pinned to an exact version (`name@x.y.z`); this command
does not resolve `latest` or ranges. Installed packages are recorded in
`plugins.json` under the unified runtime. Install the CLI first; plugin
installation fails without it because npm has no host core against which to
validate the plugin's peer dependency.

Local `.tgz` inputs are copied into DIM's managed `runtime/sources` directory,
so a later CLI replacement does not depend on the original download or build
directory. Manage an installed plugin without editing runtime files directly:

```bash
dim installer disable-plugin '@example/dim-plugin'
dim installer enable-plugin '@example/dim-plugin'
dim installer remove-plugin '@example/dim-plugin'
```

Disable keeps the package installed but stops loading it. Enable requires an
installed package. Remove uninstalls it and deletes its activation entry.

## CLI install modes

Either mode installs the CLI, core, and enabled plugins into one private,
stable npm project that is never on `PATH` directly:

```text
$XDG_DATA_HOME/dim/runtime/current/node_modules/.bin/dim
```

(falling back to `~/.local/share/dim/runtime/current/...` when `XDG_DATA_HOME` is
unset). Registry installs must match the installer's own version. Replacements
are installed and verified in a temporary sibling directory before `current`
is switched. The staged target core package then checks existing host, Project,
workspace, and CI-runner state read-only with its own parsers. Missing state and
the exact supported schemas proceed. The sole accepted historical case is host
schema 1, which prints a warning and remains byte-identical until the controller
performs its documented startup migration. Unknown plugin-private state is not
part of this check. The selected required host plugin joins the staged core/CLI
npm graph and is enabled in staged `plugins.json` before promotion. After
promotion, the installer runs the installed DIM
`controller restart` subcommand exactly once and accepts the replacement only
after that command's readiness check succeeds. Failure restores the previous
runtime and restarts its controller before reporting the error. If a later
install step fails after target readiness, the installer first stops the owned
target controller through its owner-only host-admin Unix socket and waits for
the controller to close its sockets and remove its PID file before removing the
runtime. Listener draining and plugin disposal are bounded, so a workspace or
agent holding an incomplete request cannot block restoration. If the target
cannot stop, rollback halts without deleting that running runtime or restoring
the previous runtime over it, and installation still reports the original
failure with the stop failure attached as cause. It never signals a PID supplied
by the filesystem; a clean-host failure therefore cannot leave that detached
target running or terminate an unrelated process. Temporary and backup
directories are removed after success.

Malformed, unsafe, or unsupported known state refuses installation before the
runtime, config, PATH symlink, or plugin activation changes. Keep the currently
pinned DIM version available to export needed data, then recreate the named
incompatible resource and retry. The installer never converts or deletes old
workspace, Project, or runner state.

**Direct PATH (`--local-bin`)** additionally creates or replaces a symlink
in the bin directory pointing at that versioned executable:

```text
~/.local/bin/dim -> $XDG_DATA_HOME/dim/runtime/current/node_modules/.bin/dim
```

Use `--prefix PATH` to use `PATH/bin/dim` instead of `~/.local/bin/dim`. Once
this symlink is what `PATH` resolves, `dim` runs the real CLI directly and
the facade/installer commands are no longer reached that way (see above).

The installer only ever creates, replaces, or removes a `dim` at that path
if it is already a symlink pointing inside its own managed runtime data
directory. If some other file or symlink is already there — including a
different `dim` installation — it stops with a conflict error instead of
overwriting it; inspect and clean up the existing path yourself, then re-run.

**Proxied (`--no-local-bin`)** installs to the same stable directory but
does not touch `PATH` at all. The facade instead records the absolute
executable path in its config and proxies every non-installer command to it.

```bash
dim installer install core --no-local-bin
```

For local DIM development, use the repository installation script. It stages
the bundle's exact installer tarball outside the bundle and executes that
target facade without replacing the mise shim before compatibility succeeds:

```bash
just install-dim-local
```

An already installed standalone or mise-managed facade cannot retroactively
enforce compatibility checks introduced by a newer candidate. Local install
scripts therefore use mise only to provide Node.js and npm, invoke the staged
target facade by absolute path for `installer install core`, and update a direct global
facade only after target validation and runtime promotion succeed. The
installed CLI reports the version stored in config; package-manifest versions
are not used to construct paths. Plugins share the runtime's
`@slop-lab/dim-core`, whose exact peer dependency is checked by npm before
installation succeeds.

If preparation fails before this command with an error that describes the old
`-local-<git-sha>` format, the selected production source predates the current
aggregate SHA-256 package identity. Update the reviewed core and plugin source
commits together, rebuild the bundle, and retry the same install command. Do
not shorten the aggregate identity or relax its validation.

**Default**: under `mise`, `--no-local-bin` is the default; everywhere else,
`--local-bin` is the default. The explicit flag always wins over this
detection. The interactive installer prints the direct-mode risks before it
offers `--local-bin` behavior under mise. Its yes/no question phrases the
recommended mode positively, so answering `Y` or pressing Enter chooses the
environment-specific default.

## `dim --help` / `dim --version`

Behavior depends on whether the real CLI is installed (per the facade's
config, not just `PATH`):

- **Not installed**: `dim --help` prints facade-only help (this package's own
  usage, not a pretend DIM CLI help). `dim --version` prints:
  ```text
  DIM installer 0.9.0
  DIM CLI: not installed
  ```
- **Installed**: `dim --help` is forwarded to the real CLI's own `--help`.
  `dim --version` prints:
  ```text
  DIM CLI 0.9.0 (via DIM installer 0.9.0)
  ```
  with a warning if the configured version no longer matches what's actually
installed (run `dim installer install core` again to repair).

Any other command with no CLI installed fails fast with exit code 2 and a
message pointing at `dim installer install core`, instead of guessing at some other
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
it by hand — re-run `dim installer install core` / `dim installer install plugin` to change what
it points at.

## What this does not do

The installer does not install Docker, a workspace runtime backend, or the DIM
workspace image. Its control-plane command installs only the idle service
bundle described above, not a Project adapter, CI execution capacity, Sysbox
job gate, or reviewer UI. See the
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
