# DIM Plugins

DIM has a versioned, instance-scoped plugin host. Version 0.2.0 does not expose
a Git-provider abstraction: repository import uses the host's `git` CLI and
managed repositories live in DIM's Gitea service. Plugins can register typed
routes on the authenticated DIM controller API; see
[External workspace URLs](external-urls.md).

Plugin discovery does not depend on a naming convention. Scoped, unscoped, and
private-registry package names are accepted. For example:

```text
@example/dim-plugin
@company/internal-dim-integration
dim-plugin-audit
```

It exports a versioned `DimPlugin`:

```ts
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin
} from "@slop-lab/dev-infra-manager-core";

const plugin: DimPlugin = {
  name: "@example/dim-plugin",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    host.registerControllerRoute({
      method: "GET",
      path: "/example",
      summary: "Example plugin route",
      async handle() {
        return { body: { ok: true } };
      }
    });
  }
};

export default plugin;
```

Install and explicitly enable a plugin package with:

```bash
npx '@slop-lab/install-dim@0.2.0' install-plugin '@example/dim-plugin@1.2.3'
dim plugin list
```

The installer creates a private npm project under
`${DIM_PLUGIN_HOME:-$XDG_DATA_HOME/dim/plugins}` (falling back to
`~/.local/share/dim/plugins`), installs exact direct dependencies there, and
atomically records enabled package names in `plugins.json`. `dim plugin list`
loads that explicit manifest and reports the enabled packages.

The selected plugin home is persisted in
`${XDG_CONFIG_HOME:-~/.config}/slop-lab/dim.json`, so a CLI installed with a
custom `--prefix` resolves the same plugin location in later processes.
The persisted plugin home takes precedence over a later `DIM_PLUGIN_HOME`.
That environment variable supplies an initial default only when no selection
has been recorded. `DIM_CONFIG_PATH` remains an explicit testing or portable
installation override for the otherwise fixed XDG config location.

The package name recorded by the installer and the plugin's diagnostic `name`
field need not follow the same prefix. Resolution always uses the exact
installed package name from `plugins.json`; no `plugin-*` pattern scan occurs.

Only packages listed in the manifest are imported, and their plugin API version
is validated. Registration is atomic from the caller's perspective: duplicate
names and initialization failures abort startup, and completed registrations
are disposed in reverse order. A plugin may return an async disposer from
`register`. Each controller owns its route registry instance; there is no
global capability singleton. `GET /api` discovers registered plugin routes
for an authenticated workspace.
