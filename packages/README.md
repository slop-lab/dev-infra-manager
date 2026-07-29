# Packages

Reusable contracts, executable tooling, and provider adapters belong under
`packages/`. The first directory level mirrors the npm name prefix:

- `scope-root/` contains packages named directly under `@slop-lab/`.
- `dim/` contains reusable `@slop-lab/dim-*` implementation packages.
- `dim-contracts/` contains provider-neutral
  `@slop-lab/dim-contracts-*` packages.
- `dim-plugin/` contains `@slop-lab/dim-plugin-*` packages.

Package directory names are the remainder after that prefix. For example,
`dim/provider-dns-cloudflare` publishes as
`@slop-lab/dim-provider-dns-cloudflare`.

The scope-root packages are the `dim-cli` executable and the `install-dim`
installer facade. `dim/core` owns runtime and lifecycle APIs. Shared data and
configuration boundaries belong in `dim-contracts`; implementations such as
an ingress or provider belong in `dim`. A `dim-plugin` package composes those
libraries behind DIM's plugin API.

The prefix is a naming convention, not a discovery mechanism. DIM loads only
packages explicitly listed in the plugin manifest, and third-party plugin
package names remain unrestricted; for example,
`@dev-infra-manager/plugin-github`, `@company/internal-git`, and unscoped npm
packages are all valid. Provider-specific dependencies and credentials must
not leak into core, contracts, or the CLI package.

Packages must not start daemons or mutate host state merely by being imported.
Credentials stay in application/runtime configuration and must not be embedded
in shared contracts.
