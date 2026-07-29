# Releasing

## Prerequisites

- The release commit is pushed and CI is green.
- The manually dispatched Sysbox smoke workflow passes on the release commit.
- `npm whoami` succeeds for an account allowed to publish the `@slop-lab` scope.
- The version and changelog agree, and the release tag does not already exist.

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
pnpm --filter @slop-lab/dev-infra-manager-core run pack:dry-run
pnpm --filter @slop-lab/dim-external-url-contracts run pack:dry-run
pnpm --filter @slop-lab/dim-plugin-external-urls run pack:dry-run
pnpm --filter @slop-lab/dim-provider-dns-cloudflare run pack:dry-run
pnpm --filter @slop-lab/dim-ingress-external-url-caddy run pack:dry-run
pnpm --filter @slop-lab/dim-cli run pack:dry-run
pnpm --filter @slop-lab/install-dim run pack:dry-run
```

Review every tarball listing and confirm it contains its README, MIT license,
runtime files, and publishable manifest.

## Publish 0.2.0

Publish core and the external URL packages before the CLI because the CLI and
plugin have exact dependencies on their versions:

```bash
pnpm --filter @slop-lab/dev-infra-manager-core run publish:package
pnpm --filter @slop-lab/dim-external-url-contracts run publish:package
pnpm --filter @slop-lab/dim-plugin-external-urls run publish:package
pnpm --filter @slop-lab/dim-provider-dns-cloudflare run publish:package
pnpm --filter @slop-lab/dim-ingress-external-url-caddy run publish:package
pnpm --filter @slop-lab/dim-cli run publish:package
pnpm --filter @slop-lab/install-dim run publish:package
```

Verify clean installs from the registry before creating and pushing the signed
`v0.2.0` tag and GitHub release.
