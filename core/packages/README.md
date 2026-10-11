# Packages

Reusable contracts, executable tooling, and provider adapters belong under
`packages/`. Directories describe roles within this DIM repository rather
than repeating the common `@slop-lab/dim-*` npm prefix:

- `core`, `cli`, `installer`, and `controller-proxy` are top-level product
  components.
- `contracts/` contains provider-neutral data and configuration boundaries.
- Root-level `plugin-*` directories contain packages that implement DIM's
  plugin API, including named extension providers.

Nested directory segments follow the remainder of the package name. For
example, `contracts/external-url` publishes as
`@slop-lab/dim-contracts-external-url`, while the root-level
`plugin-dns-cloudflare` publishes as `@slop-lab/dim-plugin-dns-cloudflare`.

The root `tests/` workspace holds package integration suites and their shared
fixtures. `verification/` owns cross-package, container, host, and QEMU gates;
neither directory is included in a published package.

The prefix is a naming convention, not a discovery mechanism. DIM loads only
packages explicitly listed in the plugin manifest, and third-party plugin
package names remain unrestricted; for example,
`@dev-infra-manager/plugin-github`, `@company/internal-git`, and unscoped npm
packages are all valid. Provider-specific dependencies and credentials must
not leak into core, contracts, or the CLI package.

Packages must not start daemons or mutate host state merely by being imported.
Credentials stay in application/runtime configuration and must not be embedded
in shared contracts.
