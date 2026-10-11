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
fix as its own outcome. Package-specific outcomes belong in the changelog for
their owning package or package group. Core package history lives in
`core/CHANGELOG.md`, and each plugin changelog lives in that plugin's root.
Cross-package and Project-level outcomes belong in the root `CHANGELOG.md`.
Don't copy package release history into the root changelog or create a root
release heading until that root release is actually cut.

## Prerequisites

- Following the [development repository model](development-repositories.md),
  the complete release candidate is one clean root-monorepo commit and tree.
  Production packages, plugins, tests, verification, specifications, workflows,
  and `.dim` lifecycle inputs all come from that same tree.
- DIM-managed Gitea has recorded internal review and required automatic CI for
  that exact root commit and tree. Internal review authority has no GitHub,
  package-registry, tag, or release credential.
- A trusted maintainer has separately published the same commit and tree to the
  canonical GitHub repository. Release evidence records the internal candidate
  identity and `github_canonical_sha`, and proves that both resolve to the same
  Git commit and tree rather than an assembled or substituted source set.
- The manually dispatched Sysbox and KVM installer workflows pass on the
  release commit using fresh ephemeral self-hosted runners.
- The promotion into the active DIM-managed root repository's `main` branch
  used a non-draft pull request and passed every automatic
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
Release evidence must also exercise installation against temporary state
fixtures with the exact packed candidate bundle: missing and current state must
pass, the one supported historical host record must pass without installation-
time mutation and migrate only at controller startup, and malformed or
unsupported known core state must refuse promotion while every state byte,
installed runtime, facade, user config, plugin set, and image marker remains
unchanged. The driver must prove the staged target core contract was used, not
an older installed CLI or a mutable source tree.

Run the manual backend gates locally from the committed release candidate:

```bash
just verify container
just verify environments-kvm
```

For the managed Gitea deployment gate, dispatch `QEMU release gate` from the
root repository at the exact candidate ref. The job uses the shared `dim-qemu`
runner capability and records the exact root commit and tree. Require it to pass
before host installation or `dim workspace restart`.

The release gate also runs the complete stateful and canonical self-Project
contract in a fresh QEMU integration guest. The host-installer gate uses a
separate clean Ubuntu guest for each backend, and every guest invokes the same
common full-development recipe after its backend-specific installation and
workload probes. Only a non-draft managed-host pull request targeting `main`
schedules those backend gates independently, while the local command runs all
of them.
`bash verification/scripts/local-ci-matrix.bash --manual` is the combined
local shorthand for the automatic matrix and both manual backend gates.

Record the internal candidate as `candidate_root_sha` and
`candidate_root_tree`, then record the separately published GitHub commit as
`github_canonical_sha` with its canonical ref. Require
`candidate_root_sha == github_canonical_sha` and require both repositories to
resolve that commit to `candidate_root_tree`. A matching branch name, package
version, workflow run, or working-tree archive is insufficient.

Finally, run the two manual GitHub workflows on actual ephemeral self-hosted
runners. The workflow definitions must already be present on the canonical
repository's default branch, and the canonical commit must be published by a
trusted maintainer before dispatch. From a clean canonical GitHub checkout,
verify and retain its separate evidence:

```bash
github_canonical_ref=main
github_canonical_sha="$(git rev-parse HEAD)"
github_canonical_tree="$(git rev-parse "${github_canonical_sha}^{tree}")"
test -z "$(git status --porcelain)"
git fetch GITHUB_REMOTE "$github_canonical_ref"
test "$(git rev-parse FETCH_HEAD)" = "$github_canonical_sha"
test "$candidate_root_sha" = "$github_canonical_sha"
test "$candidate_root_tree" = "$github_canonical_tree"
```

Replace `GITHUB_REMOTE` with the configured GitHub remote name. Confirm the
candidate variables come from retained internal review evidence, not from the
GitHub checkout itself. Confirm the
automatic GitHub `CI` run reports
`headSha == github_canonical_sha`; a green run for the same branch name at
another SHA does not satisfy the release gate. This GitHub-hosted workflow
intentionally performs only Node.js type checks and tests without APT or
Docker setup. The current managed Gitea remains the complete automatic CI
authority for internal review, while the local matrix and manual GitHub
workflows cover package, container, Sysbox, and KVM release gates. This hosting
separation implements the [development repository
model](development-repositories.md); Gitea remains a replaceable internal
backend and cannot publish the GitHub release.

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
normal release build preserves the exact tracked version. Reviewed local
source preparation accepts `DIM_SOURCE_ROOT_COMMIT` as one exact 40-character
monorepo commit and defaults it to the current root commit. Bundle builders set
`DIM_LOCAL_BUILD_VERSION` to `VERSION-local-AGGREGATE_SHA`, where
`AGGREGATE_SHA` is the SHA-256 of the root commit record and reviewed aggregate
lock digest. Release preparation requires the tracked root tree to match that
commit; a dirty working tree is not release evidence. Exact internal
dependencies use the same version, preventing a package manager from treating
different local source sets as an already-installed release.

```bash
pnpm --recursive run build

npm publish core/packages/core/dist
npm publish core/packages/contracts/external-url/dist
npm publish core/packages/controller-proxy/dist
npm publish core/packages/native-git/dist
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
