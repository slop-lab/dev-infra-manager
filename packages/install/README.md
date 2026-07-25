# @slop-lab/install-dim

User-local installer for the `dim` CLI and explicitly selected DIM plugins.
It invokes npm with exact versions and does not require `sudo`.

## Interactive installation

Start here for normal use:

```bash
npx "@slop-lab/install-dim@0.2.0"
```

The installer first asks whether to install the CLI, plugins, or both, then
shows the relevant destination. Interactive mode requires a TTY. Scripts and
CI should use the explicit commands below.

## Install only the CLI

Run the installer at an exact, reviewed version:

```bash
npx "@slop-lab/install-dim@0.2.0" cli
```

The default prefix is `~/.local`, producing:

```text
~/.local/bin/dim
~/.local/share/dim/plugins
```

The installer warns when the resulting binary directory is not on `PATH`. Add
it before invoking `dim`:

```bash
export PATH="$HOME/.local/bin:$PATH"
dim --version
dim --help
```

Choose another user-writable prefix when needed:

```bash
npx "@slop-lab/install-dim@0.2.0" cli --prefix "$HOME/tools/dim"
```

The installer installs the matching `@slop-lab/dim-cli` release. It does not
install Docker, a workspace runtime backend, or the DIM workspace image; use
the repository's
[host setup guide](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/usage.md)
for those prerequisites.

## Install only plugins

Install and enable one or more exact plugin packages in DIM's isolated plugin
home:

```bash
npx "@slop-lab/install-dim@0.2.0" plugin \
  "@example/dim-plugin@1.2.3"
```

Override the plugin location explicitly:

```bash
npx "@slop-lab/install-dim@0.2.0" plugin \
  --plugin-home "$HOME/.local/share/dim/plugins" \
  "@example/dim-plugin@1.2.3"
```

The plugin home is a private npm project. Enabled package names are recorded
in `plugins.json`; `dim plugin list` imports only those named packages and
validates their DIM plugin API version.

Version 0.2.0 intentionally does not expose a generic Git-provider plugin
interface. Repository import uses the host's `git` CLI.

## Persisted configuration

Installation choices are recorded in:

```sh
${XDG_CONFIG_HOME:-$HOME/.config}/slop-lab/dim.json
```

The file contains the selected install prefix and plugin home. The CLI uses it
to locate plugins. These environment variables override discovery:

- `DIM_CONFIG_PATH` selects a different installer configuration file.
- `DIM_PLUGIN_HOME` selects a different plugin home.

Re-running installation is the supported way to update the selected CLI or
plugin set. Always specify exact versions; do not use `latest` for software
that controls development containers or loads executable plugins.

Before adopting DIM or any plugin, follow the mandatory
[adoption and trust requirements](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/adoption.md).
See the
[plugin documentation](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/plugins.md)
and
[`@slop-lab/dim-cli`](https://www.npmjs.com/package/@slop-lab/dim-cli)
for the next steps.
