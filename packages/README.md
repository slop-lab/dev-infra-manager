# Packages

Reusable contracts, executable tooling, and provider adapters belong under
`packages/`.

Current packages:

- `core`: runtime, lifecycle, managed Git, state, and versioned plugin/provider
  APIs. It has no dependency on CLI parsing.
- `dim-cli`: thin executable adapter over core.
- `external-url-contracts`: provider-neutral external URL configuration and
  persistence schema.
- `external-urls`: controller system plugin and workspace-aware ingress router.
- `provider-dns-cloudflare`: Cloudflare wildcard DNS reconciliation adapter.
- `ingress-external-url-caddy`: pinned Caddy/Cloudflare DNS-01 deployment
  generator and verifier.
- `install`: thin `dim-cli` installer/facade (`@slop-lab/install-dim`,
  `npx @slop-lab/install-dim` or `mise use -g npm:@slop-lab/install-dim`);
  owns only `install-cli`/`install-plugin`/`installer` and proxies every
  other command to a separately installed `dim-cli`. See
  [Installer Facade](../specs/14-installer-facade.md).

Plugin package names are unrestricted; for example,
`@dev-infra-manager/plugin-github`, `@company/internal-git`, and unscoped npm
packages are all valid. They register through core's versioned API and are
loaded only when explicitly listed in the plugin manifest. Provider-specific
dependencies and credentials must not leak into core or the CLI package.

Packages must not start daemons or mutate host state merely by being imported.
Credentials stay in application/runtime configuration and must not be embedded
in shared contracts.
