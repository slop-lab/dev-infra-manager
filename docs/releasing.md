# Releasing

## Prerequisites

- The release commit is pushed and CI is green.
- The manually dispatched Sysbox smoke workflow passes on the release commit.
- `npm whoami` succeeds for an account allowed to publish the `@slop-lab` scope.
- The version and changelog agree, and the release tag does not already exist.

### Remove the pre-stable 0.1 packages

The public 0.1 packages predate the final naming scheme and have no stable
release commitment. At least 24 hours before publishing 0.2, remove all three
in dependency order:

```bash
npm unpublish '@slop-lab/install-dim' --force
npm unpublish '@slop-lab/dim-cli' --force
npm unpublish '@slop-lab/dev-infra-manager-core' --force
```

`dim-cli@0.1.0` depends on `dev-infra-manager-core@0.1.0`, so core must be
removed last. Removing an entire package name prevents publishing that name
again for 24 hours; a removed `name@version` can never be reused. Do not also
deprecate these packages: after successful removal there is no registry entry
left to deprecate. See npm's
[unpublish policy](https://docs.npmjs.com/policies/unpublish/) before running
these irreversible commands.

Before continuing, confirm the old packages return `E404` and that at least 24
hours have passed. The replacement core package is `@slop-lab/dim-core`;
`@slop-lab/dim-cli` and `@slop-lab/install-dim` resume at 0.2.0.

## Verify

CI runs the package checks on every supported Node.js LTS line and each
release scheduled to become LTS (currently Node.js 24 and 26). Container and
Sysbox integration checks use the newest validated line.

```bash
pnpm install --frozen-lockfile
just check
just verify-plugin-install
just verify-container
bash scripts/container-cgroup-smoke.bash
pnpm audit --prod
pnpm --filter @slop-lab/dim-core run pack:dry-run
pnpm --filter @slop-lab/dim-contracts-external-url run pack:dry-run
pnpm --filter @slop-lab/dim-plugin-external-urls run pack:dry-run
pnpm --filter @slop-lab/dim-provider-dns-cloudflare run pack:dry-run
pnpm --filter @slop-lab/dim-ingress-caddy run pack:dry-run
pnpm --filter @slop-lab/dim-cli run pack:dry-run
pnpm --filter @slop-lab/install-dim run pack:dry-run
```

Review every tarball listing and confirm it contains its README, MIT license,
runtime files, and publishable manifest.

## Publish 0.2.0

Publish core and contracts first, then their implementations and plugin, and
finally the CLI and installer. Workspace package dependencies are exact:

```bash
pnpm --filter @slop-lab/dim-core run publish:package
pnpm --filter @slop-lab/dim-contracts-external-url run publish:package
pnpm --filter @slop-lab/dim-plugin-external-urls run publish:package
pnpm --filter @slop-lab/dim-provider-dns-cloudflare run publish:package
pnpm --filter @slop-lab/dim-ingress-caddy run publish:package
pnpm --filter @slop-lab/dim-cli run publish:package
pnpm --filter @slop-lab/install-dim run publish:package
```

Verify clean installs from the registry before creating and pushing the signed
`v0.2.0` tag and GitHub release.
