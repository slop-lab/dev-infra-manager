# Releasing

## Changelog policy

Changelogs describe user-visible release outcomes, not the sequence of commits
that produced them. Add an entry for a behavior, contract, operational
requirement, or migration that a release consumer needs to understand. Group
related implementation, test, and documentation commits under that outcome;
do not add entries for internal refactors or verification-only changes that do
not change the released contract.

Keep each unreleased outcome as one evolving entry. A fix or refinement to a
feature introduced in the same unreleased version updates that feature's
existing entry instead of adding a second entry describing the intermediate
defect. Once an affected version has been released, record a later user-visible
fix as its own outcome. Package-specific entries belong in the paired
`*-development` repository when one exists; cross-package release outcomes
belong in the development repository changelog.

## Prerequisites

- Following the [development repository model](development-repositories.md),
  all 11 reviewed managed `main` heads have been published to their independent
  GitLab development upstreams. `dim repo publish dim` performs this GitLab
  publication only.
- A trusted maintainer has separately assembled and published the integrated
  canonical commit to GitHub. DIM-managed Gitea and `dim repo publish dim` have
  no authority over that publication or the GitHub release.
- Release evidence records 11 GitLab split repository SHAs and one canonical
  GitHub SHA as distinct fields. It does not treat them as one shared commit.
  Automatic CI is green for each reviewed development head and for the
  canonical GitHub commit under the policies defined for those repositories.
- The manually dispatched Sysbox and KVM installer workflows pass on the
  release commit using fresh ephemeral self-hosted runners.
- The promotion into the active DIM-managed development repository's `main`
  branch used a non-draft pull request and passed every automatic
  `host backend (BACKEND)` job. These run the same
  `just verify environments-kvm BACKEND` verification through managed runners; the manual
  GitHub run remains an independent release check on a fresh runner against
  the separately published canonical commit.
- `npm whoami` succeeds for an account allowed to publish the `@slop-lab` scope.
- The version and changelog agree, and the release tag does not already exist.

## Verify

CI runs the source compatibility checks on every supported Node.js LTS line
and each release scheduled to become LTS (currently Node.js 24 and 26).
Managed workspace and QEMU integration checks use the newest validated line.
Persistent Sysbox runners advertise ordinary labels only; integration labels
and `dim-qemu` select fresh one-job QEMU guests.

```bash
bash verification/scripts/local-ci-matrix.bash
```

This uses mise to reproduce the Node.js 24/26 CI workflow matrix and the
Node.js 26 container lane. Review every package dry-run listing and confirm it
contains its README, MIT license, runtime files, and publishable manifest.

Run the manual backend gates locally from the committed release candidate:

```bash
just verify container
just verify environments-kvm
```

For the managed Gitea deployment gate, dispatch `QEMU release gate` from the
integrated `development` repository at the exact candidate ref and set
`root-ref` to the reviewed root branch, tag, or commit being deployed. The job
uses the shared `dim-qemu` runner capability and records the exact assembled
repository set. Require it to pass before host installation or
`dim workspace restart`.

The release gate also runs the complete stateful and canonical self-Project
contract in a fresh QEMU integration guest. The host-installer gate uses a
separate clean Ubuntu guest for each backend, and every guest invokes the same
common full-development recipe after its backend-specific installation and
workload probes. Only a non-draft managed-host pull request targeting `main`
schedules those backend gates independently, while the local command runs all
of them.
`bash verification/scripts/local-ci-matrix.bash --manual` is the combined
local shorthand for the automatic matrix and both manual backend gates.

After running `dim repo publish dim`, record the exact GitLab `main` SHA for
each split upstream in the release evidence:

| GitLab repository | Ref | Evidence field |
| --- | --- | --- |
| `root` | `main` | `gitlab_root_sha` |
| `development` | `main` | `gitlab_development_sha` |
| `core` | `main` | `gitlab_core_sha` |
| `core-development` | `main` | `gitlab_core_development_sha` |
| `plugin-dns-cloudflare` | `main` | `gitlab_plugin_dns_cloudflare_sha` |
| `plugin-dns-cloudflare-development` | `main` | `gitlab_plugin_dns_cloudflare_development_sha` |
| `plugin-external-urls` | `main` | `gitlab_plugin_external_urls_sha` |
| `plugin-external-urls-development` | `main` | `gitlab_plugin_external_urls_development_sha` |
| `verification` | `main` | `gitlab_verification_sha` |
| `examples` | `main` | `gitlab_examples_sha` |
| `specification` | `main` | `gitlab_specification_sha` |

Record the integrated GitHub commit separately as `github_canonical_sha`,
together with its canonical ref. The GitLab SHAs prove split development
publication. The GitHub SHA proves the separately assembled canonical
publication. They are not expected to be equal.

Finally, run the two manual GitHub workflows on actual ephemeral self-hosted
runners. The workflow definitions must already be present on the canonical
repository's default branch, and the canonical commit must be published by a
trusted maintainer before dispatch. From a clean canonical GitHub checkout,
verify and retain its separate evidence:

```bash
github_canonical_ref=main
github_canonical_sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
git fetch GITHUB_REMOTE "$github_canonical_ref"
test "$(git rev-parse FETCH_HEAD)" = "$github_canonical_sha"
```

Replace `GITHUB_REMOTE` with the configured GitHub remote name. Confirm the
automatic GitHub `CI` run reports
`headSha == github_canonical_sha`; a green run for the same branch name at
another SHA does not satisfy the release gate. This GitHub-hosted workflow
intentionally performs only Node.js type checks and tests without APT or
Docker setup. The current managed Gitea remains the complete automatic CI
authority for internal review, while the local matrix and manual GitHub
workflows cover package, container, Sysbox, and KVM release gates. This split
implements the [development repository model](development-repositories.md);
it is not a permanent Gitea contract.

GitHub workflow dispatch accepts a branch or tag ref, not an arbitrary commit
SHA. Dispatch with the verified `github_canonical_ref`, then require the
resulting run's `headSha` to equal `github_canonical_sha` as shown below.

Build and verify the reviewed runner image once:

```bash
just runner build
just runner verify
gh auth status
```

For each workflow below, start one ephemeral runner in the first terminal. Wait
until it reports that it is registered and waiting for one job:

```bash
GITHUB_RUNNER_URL=https://github.com/slop-lab/dev-infra-manager \
just runner run
```

Then dispatch exactly one workflow at the pushed release ref from a second
terminal and watch it to completion:

```bash
gh workflow run sysbox-smoke.yml --ref "$github_canonical_ref"
run_id="$(gh run list --workflow sysbox-smoke.yml --commit "$github_canonical_sha" \
  --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status
test "$(gh run view "$run_id" --json headSha --jq .headSha)" = "$github_canonical_sha"
```

Start a fresh ephemeral runner, then repeat for the KVM installer workflow:

```bash
gh workflow run kvm-backend-install.yml --ref "$github_canonical_ref"
run_id="$(gh run list --workflow kvm-backend-install.yml --commit "$github_canonical_sha" \
  --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status
test "$(gh run view "$run_id" --json headSha --jq .headSha)" = "$github_canonical_sha"
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

Tracked publishable-package manifests remain `private: true`; builds generate
minimal publish manifests without development scripts or dependencies. A
normal release build preserves the exact tracked version. Local source
preparation requires `DIM_SOURCE_CORE_COMMIT`,
`DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT`, and
`DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT`, each set to an exact 40-character
production commit. Bundle builders set `DIM_LOCAL_BUILD_VERSION` to
`VERSION-local-AGGREGATE_SHA[-dirty]`, where `AGGREGATE_SHA` is the SHA-256 of
the ordered repository-name and full-commit records. Exact internal
dependencies use that same version, preventing a package manager from treating
different local source sets as an already-installed release.

```bash
pnpm --recursive run build

npm publish core/packages/core/dist
npm publish core/packages/contracts/external-url/dist
npm publish core/packages/controller-proxy/dist
npm publish plugin-dns-cloudflare/dist
npm publish plugin-external-urls/dist
npm publish core/packages/cli/dist
npm publish core/packages/installer/dist
```

Verify clean installs of the released version from the registry in an empty
temporary directory. Confirm the installer can install the CLI and plugin,
`dim plugin list` succeeds, and the package versions match the release.

```bash
release_version="$(node -p 'require("./package.json").version')"
git tag --sign "v$release_version" --message "DIM $release_version"
git push GITHUB_REMOTE "v$release_version"
```

Create the GitHub release from that tag and use the changelog entry as its
notes. Package unpublishing is not part of the normal release process; consult
npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish/) separately
if an exceptional cleanup is required.
