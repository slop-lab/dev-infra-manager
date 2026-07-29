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
pnpm --filter @slop-lab/dim-core run pack:dry-run
pnpm --filter @slop-lab/dim-contracts-external-url run pack:dry-run
pnpm --filter @slop-lab/dim-controller-proxy run pack:dry-run
pnpm --filter @slop-lab/dim-plugin-external-urls run pack:dry-run
pnpm --filter @slop-lab/dim-provider-dns-cloudflare run pack:dry-run
pnpm --filter @slop-lab/dim-ingress-caddy run pack:dry-run
pnpm --filter @slop-lab/dim-cli run pack:dry-run
pnpm --filter @slop-lab/dim-installer run pack:dry-run
```

Review every tarball listing and confirm it contains its README, MIT license,
runtime files, and publishable manifest.

## Publish 0.2.0

Publish core and contracts first, then their implementations and plugin, and
finally the CLI and installer. Workspace package dependencies are exact:

```bash
pnpm --filter @slop-lab/dim-core run publish:package
pnpm --filter @slop-lab/dim-contracts-external-url run publish:package
pnpm --filter @slop-lab/dim-controller-proxy run publish:package
pnpm --filter @slop-lab/dim-provider-dns-cloudflare run publish:package
pnpm --filter @slop-lab/dim-ingress-caddy run publish:package
pnpm --filter @slop-lab/dim-plugin-external-urls run publish:package
pnpm --filter @slop-lab/dim-cli run publish:package
pnpm --filter @slop-lab/dim-installer run publish:package
```

Verify clean 0.2 installs from the registry. Then remove the three pre-stable
0.1 versions:

```bash
npm unpublish '@slop-lab/install-dim@0.1.0'
npm unpublish '@slop-lab/dim-cli@0.1.0'
npm unpublish '@slop-lab/dev-infra-manager-core@0.1.0'
```

Publish `dim-cli@0.2.0` before removing `dim-cli@0.1.0`, so the package name
never disappears and no 24-hour name lock applies. Core is removed last
because `dim-cli@0.1.0` depends on it. The old installer and core names are not
reused; their package entries may disappear when their only version is
removed. A removed `name@version` can never be reused. See npm's
[unpublish policy](https://docs.npmjs.com/policies/unpublish/) before running
these irreversible commands.

After registry cleanup, create and push the signed `v0.2.0` tag and GitHub
release.
