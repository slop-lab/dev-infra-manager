# DIM Plugins

DIM has a versioned, instance-scoped plugin host. DIM does not need a
Git-provider abstraction for repository URLs: `repo add` and `repo apply` use
the invoking host's `git` CLI and managed repositories live in DIM's Gitea
service. Provider plugins are reserved for host-specific API capabilities such
as creating a remote repository or opening a pull request. Plugins can register typed
routes and narrowly scoped host-input providers on the authenticated DIM
controller API; see
[External workspace URLs](external-urls.md).

## Named extensions

Plugins can provide implementation objects to other plugins without creating
a package dependency:

```ts
host.registerExtension("example.storage", "company-driver", driver);
```

A consumer resolves it from the same controller instance:

```ts
const driver = host.extension("example.storage", configuredDriverName);
```

Extension kind/name pairs are unique and use lowercase dotted or hyphenated
names. Registration remains explicit and instance-scoped: installing a package
does not activate it unless it is also listed in `plugins.json`. The External
URL system uses this mechanism for DNS provider drivers.

Plugin discovery does not depend on a naming convention. Scoped, unscoped, and
private-registry package names are accepted. For example:

```text
@example/dim-plugin
@company/internal-dim-integration
dim-plugin-audit
```

## Host-input providers

A plugin may register a provider that returns one string for an authenticated
workspace request:

```ts
host.registerHostInputProvider("company.developer-setting", {
  async resolve(request, context) {
    // request.key is required; request.parameters is an optional string.
    // context identifies the authenticated Project and workspace.
    return readAllowedSetting(request.key, context);
  }
});
```

Providers decide which keys and optional parameter strings they accept. DIM
does not cache results; `.dim/setup.sh` normally requests them again on every
workspace start. The built-in `builtin.git-author` provider exposes only
`name` and `email`, corresponding to the host's effective Git `user.name` and
`user.email`.

The managed controller runs providers on the host. Its authenticated Unix
socket is mounted into the trusted project-root container, not into nested
Compose services.

It exports a versioned `DimPlugin`:

```ts
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin
} from "@slop-lab/dim-core";

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
npx '@slop-lab/dim-installer@0.7.0' install-plugin '@example/dim-plugin@1.2.3'
dim plugin list
```

If a plugin prevents controller startup, disable it without importing it, then
enable it after correction or remove it entirely:

```bash
dim disable-plugin '@example/dim-plugin'
dim enable-plugin '@example/dim-plugin'
dim remove-plugin '@example/dim-plugin'
```

The installer maintains one npm project under
`$XDG_DATA_HOME/dim/runtime/current` (falling back to
`~/.local/share/dim/runtime/current`) for the CLI, core, and plugins. It installs
exact plugin dependencies there and atomically records enabled package names in
the adjacent `plugins.json`. `DIM_PLUGIN_HOME` exists only as an explicit test
or portable-runtime override; normal installation has no separate plugin home.
Tarball inputs are copied to `runtime/sources`, so deleting the original local
build artifact does not break a later CLI replacement.

The package name recorded by the installer and the plugin's diagnostic `name`
field need not follow the same prefix. Resolution always uses the exact
installed package name from `plugins.json`; no `plugin-*` pattern scan occurs.

Only packages listed in the manifest are imported, and their plugin API version
is validated. Registration is atomic from the caller's perspective: duplicate
names and initialization failures abort startup, and completed registrations
are disposed in reverse order. A plugin may return an async disposer from
`register`. Each controller owns its route and extension registry instances;
there is no global capability singleton. `GET /api` discovers registered plugin routes
for an authenticated workspace.

Plugin packages declare the exact supported `@slop-lab/dim-core` as a peer
dependency. npm therefore rejects an incompatible CLI/core/plugin graph during
installation, while `DIM_PLUGIN_API_VERSION` remains the runtime protocol check.
Behavioral compatibility still requires integration tests for the pinned
combination; semver and peer resolution cannot prove behavior.
