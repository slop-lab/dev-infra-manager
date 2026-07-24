# Releasing

## Prerequisites

- The release commit is pushed and CI is green.
- The manually dispatched Sysbox smoke workflow passes on the release commit.
- `npm whoami` succeeds for an account allowed to publish the `@slop-lab` scope.
- The version and changelog agree, and the release tag does not already exist.

## Verify

```bash
pnpm install --frozen-lockfile
just verify
just container-runtime-verify
pnpm audit --prod
pnpm --filter @slop-lab/dev-infra-manager-core run pack:dry-run
pnpm --filter @slop-lab/dim-cli run pack:dry-run
pnpm --filter @slop-lab/install-dim run pack:dry-run
```

Review every tarball listing and confirm it contains its README, MIT license,
runtime files, and publishable manifest.

## Publish 0.1.0

Publish core first because the CLI has an exact dependency on its version:

```bash
pnpm --filter @slop-lab/dev-infra-manager-core run publish:package
pnpm --filter @slop-lab/dim-cli run publish:package
pnpm --filter @slop-lab/install-dim run publish:package
```

Verify clean installs from the registry before creating and pushing the signed
`v0.1.0` tag and GitHub release.
