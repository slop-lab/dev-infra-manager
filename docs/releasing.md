# Releasing

## Prerequisites

- The release commit is pushed to both the development Gitea repository and
  the public GitHub repository, and automatic CI is green at that exact commit.
- The manually dispatched Sysbox and KVM installer workflows pass on the
  release commit using fresh ephemeral self-hosted runners.
- `npm whoami` succeeds for an account allowed to publish the `@slop-lab` scope.
- The version and changelog agree, and the release tag does not already exist.

## Verify

CI runs the package checks on every supported Node.js LTS line and each
release scheduled to become LTS (currently Node.js 24 and 26). Container and
Sysbox integration checks use the newest validated line.

```bash
just ci-matrix
```

This uses mise to reproduce the Node.js 24/26 CI workflow matrix and the
Node.js 26 container lane. Review every package dry-run listing and confirm it
contains its README, MIT license, runtime files, and publishable manifest.

Run the manual backend gates locally from the committed release candidate:

```bash
just ci-sysbox
just verify-environments-kvm
```

The KVM gate uses a separate clean Ubuntu guest for each backend. Its runc
guest installs the RootlessKit AppArmor profile through the host installer and
runs the canonical self-Project verification, including the unprivileged agent
and its private rootless-DinD sidecar. `just ci-matrix --manual` is the combined
local shorthand for the automatic matrix and both manual backend gates.

Finally, run the two manual GitHub workflows on actual ephemeral self-hosted
runners. The workflow definitions must already be present on the repository's
default branch, and the release commit must be pushed before dispatch.

Record the candidate SHA once and use it for every dispatch and comparison:

```bash
release_sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
test "$(git rev-parse origin/development)" = "$release_sha"
git fetch GITHUB_REMOTE development
test "$(git rev-parse FETCH_HEAD)" = "$release_sha"
```

Replace `GITHUB_REMOTE` with the configured GitHub remote name. Confirm the
automatic GitHub `CI` and `Container integration` runs both report
`headSha == release_sha`; a green run for the same branch name at another SHA
does not satisfy the release gate. Gitea remains the development CI authority,
while these GitHub-hosted runs validate the public mirror and hosted-runner
path used by downstream users.

Build and verify the reviewed runner image once:

```bash
just build-github-runner-kvm
just verify-github-runner-kvm
gh auth status
```

For each workflow below, start one ephemeral runner in the first terminal. Wait
until it reports that it is registered and waiting for one job:

```bash
GITHUB_RUNNER_URL=https://github.com/slop-lab/dev-infra-manager \
just run-github-runner-kvm
```

Then dispatch exactly one workflow at the pushed release ref from a second
terminal and watch it to completion:

```bash
gh workflow run sysbox-smoke.yml --ref "$release_sha"
run_id="$(gh run list --workflow sysbox-smoke.yml --commit "$release_sha" \
  --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status
test "$(gh run view "$run_id" --json headSha --jq .headSha)" = "$release_sha"
```

Start a fresh ephemeral runner, then repeat for the KVM installer workflow:

```bash
gh workflow run kvm-backend-install.yml --ref "$release_sha"
run_id="$(gh run list --workflow kvm-backend-install.yml --commit "$release_sha" \
  --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status
test "$(gh run view "$run_id" --json headSha --jq .headSha)" = "$release_sha"
```

Each runner accepts one job and deletes its VM overlay and SSH key afterward.
Confirm both workflow runs used the intended release commit and completed
successfully before publishing.

## Publish

Publish core and contracts first, then their implementations and plugin, and
finally the CLI and installer. Workspace package dependencies are exact.
Build the publishable packages, then invoke `npm publish` directly from the
release commit. Do not run `npm publish` through a pnpm script: pnpm exports
pnpm-only `npm_config_*` values that current npm versions warn about and a
future npm major may reject.

```bash
pnpm --recursive run build

npm publish packages/core/dist
npm publish packages/contracts/external-url/dist
npm publish packages/controller-proxy/dist
npm publish packages/plugin/dns-cloudflare/dist
npm publish packages/plugin/external-urls/dist
npm publish packages/cli/dist
npm publish packages/installer/dist
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
