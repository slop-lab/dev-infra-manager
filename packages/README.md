# Packages

Reusable contracts, executable tooling, and provider adapters belong under
`packages/`. The first directory level mirrors the npm name prefix:

- `scope-root/` contains packages named directly under `@slop-lab/`.
- `dev-infra-manager/` contains `@slop-lab/dev-infra-manager-*` packages.
- `dim-plugin/` contains `@slop-lab/dim-plugin-*` packages.

Package directory names are the remainder after that prefix. For example,
`dim-plugin/provider-dns-cloudflare` publishes as
`@slop-lab/dim-plugin-provider-dns-cloudflare`.

The scope-root packages are the `dim-cli` executable and the `install-dim`
installer facade. `dev-infra-manager/core` owns runtime and lifecycle APIs.
The `dim-plugin` group contains external URL contracts, the controller plugin,
and its provider and ingress adapters.

Plugin package names are unrestricted; for example,
`@dev-infra-manager/plugin-github`, `@company/internal-git`, and unscoped npm
packages are all valid. They register through core's versioned API and are
loaded only when explicitly listed in the plugin manifest. Provider-specific
dependencies and credentials must not leak into core or the CLI package.

Packages must not start daemons or mutate host state merely by being imported.
Credentials stay in application/runtime configuration and must not be embedded
in shared contracts.
