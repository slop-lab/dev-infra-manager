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

## Candidate identity

The release candidate is one clean root-monorepo commit and tree. Production
packages, plugins, centralized tests, verification, specifications, workflows,
and reviewed root `.dim` lifecycle inputs all come from that tree. Do not build
a release from an assembled directory, sibling checkout, or uncommitted state.

Record:

```bash
candidate_root_sha="$(git rev-parse HEAD)"
candidate_root_tree="$(git rev-parse 'HEAD^{tree}')"
test -z "$(git status --porcelain)"
```

Native DIM review and checked protected-ref promotion establish internal
candidate identity. Publishing that exact commit to the canonical GitHub
repository remains a separate trusted-maintainer action. GitHub contribution
workflows are not a DIM runtime provider and receive no native Git, reviewer,
promotion, installer, registry, or host credential.

## Required verification

Run source and package verification from the exact candidate:

```bash
just check-source-native
just verify package-packs
just verify native-idle-service-images
just verify control-plane-install-live
```

Review every package dry-run listing and confirm it contains its README,
license, runtime files, declarations, and publishable manifest. Installer
evidence must use the exact packed target, prove missing/current state succeeds,
and prove obsolete or malformed known state fails before changing runtime,
facade, configuration, plugins, image markers, or state bytes.

Run the two mechanics classes on capable disposable hosts:

```bash
just verify native-ordinary-guest-mechanics
just verify native-qemu-guest-mechanics-kvm
```

The QEMU lane requires real readable/writable `/dev/kvm`; TCG is not accepted.
Same-host mechanics are not independent-host release acceptance. Retain the
evidence and separately complete `VERIFICATION-NATIVE-CUTOVER-001`, including
fault, stale/wrong-kind, replay, crash/reboot, guest-authority, traffic,
interactive human approval, and checked promotion observations. Missing
hardware is `unavailable`, never a pass.

The GitHub workflows `.github/workflows/verify.yml` and
`.github/workflows/integration.yml` must run against the canonical candidate
SHA. Dispatch ordinary and `qemu-kvm` integration lanes on fresh matching
self-hosted runners and require their recorded `headSha` to equal
`candidate_root_sha`.

## Publish

Before publication, reconcile package versions, package-group and root
changelogs, exact dependency pins, generated package contents, and the release
tag. Confirm `npm whoami` for an account allowed to publish `@slop-lab`.

Publish core and contracts before dependent packages, then plugins, CLI, and
installer. Use the package manager's exact-version and provenance controls; do
not publish `latest`-resolved inputs or a dirty tree. After publication, install
the exact released installer and CLI on a clean disposable host and repeat the
readiness and unavailable-capability checks before creating the tag/release
record.

Release completion does not authorize disposal of predecessor resources.
Operators export with the pinned prior release, validate data outside DIM
state, create fresh native state, and dispose of old containers, volumes,
remotes, credentials, and databases only as a separate explicit action.
