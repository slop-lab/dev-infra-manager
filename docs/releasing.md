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
just ci-matrix --manual
```

This uses mise to reproduce the Node.js 24/26 GitHub Actions matrix and the
Node.js 26 container lane, followed by both manually dispatched Sysbox and KVM
workflows. It requires the same Sysbox, QEMU, and `/dev/kvm` host capabilities
as their self-hosted runners. Review every package dry-run listing and confirm
it contains its README, MIT license, runtime files, and publishable manifest.

## Publish

Publish core and contracts first, then their implementations and plugin, and
finally the CLI and installer. Workspace package dependencies are exact.
Run these commands from the release commit:

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

Verify clean installs of the released version from the registry in an empty
temporary directory. Confirm the installer can install the CLI and plugin,
`dim plugin list` succeeds, and the package versions match the release.

```bash
release_version="$(node -p 'require("./package.json").version')"
git tag --sign "v$release_version" --message "DIM $release_version"
git push origin "v$release_version"
```

Create the GitHub release from that tag and use the changelog entry as its
notes. Package unpublishing is not part of the normal release process; consult
npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish/) separately
if an exceptional cleanup is required.
