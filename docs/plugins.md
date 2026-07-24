# DIM Plugins

DIM keeps optional hosting integrations outside the CLI and core package.
The first extension point is the repository provider contract exported by
`@slop-lab/dev-infra-manager-core`.

Plugin discovery does not depend on a naming convention. Scoped, unscoped, and
private-registry package names are accepted. For example:

```text
@dev-infra-manager/plugin-github
@company/internal-git-provider
dim-plugin-local-mirror
```

It exports a versioned `DimPlugin` and registers one or more
`RepositoryProvider` implementations:

```ts
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin
} from "@slop-lab/dev-infra-manager-core";

const plugin: DimPlugin = {
  name: "@dev-infra-manager/plugin-github",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    host.registerRepositoryProvider({
      kind: "github-mirror",
      async register(request, context) {
        // Resolve and mirror request.source, then return a role-neutral
        // RepoRecord managed through context.lifecycle.
        throw new Error("example only");
      }
    });
  }
};

export default plugin;
```

Install and explicitly enable a plugin package with:

```bash
npx "@slop-lab/install-dim@0.1.0" "@dev-infra-manager/plugin-github@1.2.3"
dim plugin list
```

The installer creates a private npm project under
`${DIM_PLUGIN_HOME:-$XDG_DATA_HOME/dim/plugins}` (falling back to
`~/.local/share/dim/plugins`), installs exact direct dependencies there, and
atomically records enabled package names in `plugins.json`. `dim plugin list`
loads that explicit manifest and reports the repository provider kinds
registered by each plugin.

The package name recorded by the installer and the plugin's diagnostic `name`
field need not follow the same prefix. Resolution always uses the exact
installed package name from `plugins.json`; no `plugin-*` pattern scan occurs.

The contract deliberately separates provider installation from provider use.
Installing a package must not silently enable it. A future CLI loader should:

1. Read an explicit list of package specifiers from DIM configuration.
2. Import only those packages.
3. require the same major `DIM_PLUGIN_API_VERSION`.
4. reject duplicate provider kinds.
5. pass core services through `RepositoryProviderContext` instead of exposing
   CLI parser internals or mutable global state.

GitHub and GitLab credentials remain provider-owned configuration. Provider
packages should return the same role-neutral `RepoRecord` used by local
registration, so workspace lifecycle code does not branch on a hosting
vendor. CLI commands such as a future `repo github-mirror register` should be
thin adapters over the installed provider.

Provider-specific commands are intentionally not enabled until the first real
provider exists. Dynamic loading, version validation, duplicate rejection, and
installation are already implemented without freezing provider-specific CLI
syntax.
