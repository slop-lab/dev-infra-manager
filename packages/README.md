# Packages

Reusable contracts, executable tooling, and provider adapters belong under
`packages/`.

Current packages:

- `core`: runtime, lifecycle, managed Git, state, and versioned plugin/provider
  APIs. It has no dependency on CLI parsing.
- `dim-cli`: thin executable adapter over core.
- `install`: standalone `npx @slop-lab/install-dim` plugin installer.

Plugin package names are unrestricted; for example,
`@dev-infra-manager/plugin-github`, `@company/internal-git`, and unscoped npm
packages are all valid. They register through core's versioned API and are
loaded only when explicitly listed in the plugin manifest. Provider-specific
dependencies and credentials must not leak into core or the CLI package.

Packages must not start daemons or mutate host state merely by being imported.
Credentials stay in application/runtime configuration and must not be embedded
in shared contracts.
