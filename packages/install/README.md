# @slop-lab/install-dim

Installs the `dim` CLI without requiring `sudo`:

```bash
npx "@slop-lab/install-dim@0.1.0"
```

With no arguments, the installer interactively offers to install the DIM CLI,
plugins, or both. The matching `@slop-lab/dim-cli` version is installed under
`~/.local` by default. Ensure `~/.local/bin` is in `PATH`.

For non-interactive installation, use the explicit `cli` command:

```bash
npx "@slop-lab/install-dim@0.1.0" cli
npx "@slop-lab/install-dim@0.1.0" cli --prefix "$HOME/.local"
```

Install an optional plugin into the isolated plugin home with the explicit
`plugin` command:

```bash
npx "@slop-lab/install-dim@0.1.0" plugin "PACKAGE_NAME@EXACT_VERSION"
```

The installer records the selected install prefix and plugin home in
`${XDG_CONFIG_HOME:-~/.config}/slop-lab/dim.json`. The `dim` CLI reads this
file when locating plugins. `DIM_CONFIG_PATH` and `DIM_PLUGIN_HOME` remain
available as explicit overrides.

Pin the installer and every plugin to reviewed exact versions. See the mandatory
[adoption and trust requirements](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/adoption.md).

See the [plugin documentation](https://github.com/slop-lab/dev-infra-manager/blob/main/docs/plugins.md)
for the plugin contract and security model.
