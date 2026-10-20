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
`docs/history/core-releases.md`, and each plugin changelog lives in that plugin's root.
Cross-package and Project-level outcomes belong in the root `CHANGELOG.md`.

## Candidate identity

The release candidate is one clean root-monorepo commit and tree. Production
packages, plugins, centralized tests, verification, specifications, workflows,
and explicit repository development scripts all come from that tree. Do not build
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

## Internal development preparation

A pre-stable internal-development target may reconcile source package versions,
exact DIM dependency and peer pins, the package-manager lockfile, source version
constants, current examples, and owned changelogs before the tree becomes a
clean release candidate. Regenerate the lockfile with the pinned package
manager; do not hand-edit it. The matched source package set may then be used by
the reviewed local source workflow and the pre-stable operations gate.

Fresh Ubuntu 24.04 amd64 trials may use the
[role bootstrap](../development/bootstrap-ubuntu-vm.md) from that clean
reviewed commit. The bootstrap does not provision private service roles or
replace the subsequent operator-owned two-node operations gate. Record a new
bootstrap execution against the candidate; older VM results do not prove new
installer code or a newly versioned artifact set.

Keep candidate-specific results, timestamps, and logs in external CI artifacts
or operator evidence directories, not in tracked preparation reports. Tracked
documentation describes reproducible commands and evidence requirements; an
older successful run never establishes the current candidate's readiness.

This preparation does not publish packages or images, create a tag or release,
deploy services, or establish public availability. Native multi-host operations
evidence remains candidate-controlled and does not satisfy independent-host,
human, or full public release acceptance. Any later public candidate must use
one clean exact commit and separately complete every applicable verification,
acceptance, provenance, publication, and post-publication step below before
those claims are made.

## Required verification

Run source and package verification from the exact candidate:

```bash
for node_major in 24 26; do
  DIM_SOURCE_NODE_MAJOR="$node_major" bash scripts/checks/source-gate-container.bash \
    bash -lc 'just check-source-native && just verify package-packs && pnpm audit --prod'
done
just verify native-idle-service-images
just verify installer-artifacts
```

The heavy examples gate is also required before merging into `main` and before
release. `.github/workflows/examples.yml` runs `examples-vm` for `main` pull
requests and merge groups; dispatch it explicitly for the frozen release
candidate. It does not run on every `development` push. Configure the
`examples-vm` required check in the repository's `main` rules separately;
workflow source does not configure branch protection.

Use a disposable `dim-native-qemu` runner with real readable/writable `/dev/kvm`
and the [fresh VM prerequisites](../development/bootstrap-ubuntu-vm.md#disposable-fresh-vm-acceptance-profile).
The exact candidate gate can also be invoked directly:

```bash
DIM_EXAMPLES_VM_LOG_ROOT=/absolute/private/examples-evidence \
  bash scripts/checks/examples-vm-smoke.bash
```

Retain its successful outer result, guest example results, source manifest and
commit/tree evidence. A missing runner is pending; missing KVM is unavailable
and fails the gate. Neither is a successful skip. PR/merge-queue candidates can
be synthetic commits, so compare the uploaded commit/tree with the candidate
being accepted. A different release commit/tree requires new evidence.

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

The isolated source gate needs Bash and Docker on the invoking host, not sudo
or a host pnpm installation. Its root-owned fixtures exist only inside its
disposable container. `just check-source-native` is for an already pinned,
disposable environment, not an ordinary hosted-runner user or a live sudo shell.

The GitHub workflows `.github/workflows/verify.yml`,
`.github/workflows/integration.yml`, and `.github/workflows/examples.yml` must run against the canonical candidate
SHA. Dispatch ordinary and `qemu-kvm` integration lanes on fresh matching
self-hosted runners and require their recorded `headSha` to equal
`candidate_root_sha`.

### GitHub manual triggers

Manual dispatch does not install or register a runner. Before dispatching:

- The workflow file must be present on the repository's **default branch**,
  and must declare `workflow_dispatch`. A file present only on `development`
  is not sufficient. Have a maintainer review and promote a compatible source
  revision containing the native workflows into the default branch; do not
  copy just the YAML onto incompatible source, change the default branch, or run
  predecessor workflows to bypass this prerequisite. Check with
  `gh repo view --json defaultBranchRef` and `gh workflow list --all`.
- The selected branch or tag must point at the reviewed clean candidate.
  Dispatch uses a branch/tag ref, not a promise that a moving branch will
  remain at the SHA inspected earlier. Freeze the ref for all four dispatches
  and reject any run whose `headSha` differs from the candidate.
- The source workflow uses fresh `ubuntu-24.04` hosted runners. Integration
  requires fresh, disposable Linux self-hosted runners with labels
  `dim-native-ordinary` and `dim-native-qemu`, respectively. Prepare a supported
  Node.js 24/26 host interpreter, Just 1.43.1, Docker with Buildx and Compose,
  and the normal runner user's Docker access before dispatch. The workflow
  installs pnpm 10.13.1 and builds all packages before its live gates.
- The ordinary runner needs registered `sysbox-runc`, supported Docker image
  mounts, and cached digest-pinned images selected by its reviewed fixed
  `DIM_TEST_NATIVE_RUNNER_IMAGE` and `DIM_TEST_NATIVE_JOB_IMAGE` environment.
  The fixture pins are defined in
  `scripts/checks/native-ordinary-guest-mechanics-smoke.bash`; configure
  the runner environment and preload those images before starting its service.
  These are public test images, not production role credentials.
- The QEMU runner must be x86-64 with a character `/dev/kvm` readable and
  writable by the runner user and usable from Docker. TCG is not accepted.
  Missing/offline runners leave a job queued, not passed. Use only disposable
  test hosts; do not expose production DIM state, credentials, or protected
  host verification services to GitHub jobs.

See GitHub's [manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
for the default-branch requirement. In the UI, select **Actions → workflow →
Run workflow**, choose the reviewed branch/tag, and select the integration
lane. Repeat for both integration lanes. CLI equivalent, after the prerequisites
and reviewed candidate publication are complete:

```bash
repository=slop-lab/dev-infra-manager
candidate_ref=development # Or an operator-maintained, frozen candidate branch/tag.
candidate_root_sha="$(git rev-parse HEAD)"
(
  set -euo pipefail
  test -z "$(git status --porcelain)"
  test "$(gh api "repos/$repository/commits/$candidate_ref" --jq .sha)" = "$candidate_root_sha"
  default_branch="$(gh repo view "$repository" --json defaultBranchRef --jq .defaultBranchRef.name)"
  for workflow in verify.yml integration.yml examples.yml; do
    gh api --method GET "repos/$repository/contents/.github/workflows/$workflow" \
      -f ref="$default_branch" --jq .sha >/dev/null
  done

  gh workflow run verify.yml --repo "$repository" --ref "$candidate_ref"
  gh workflow run examples.yml --repo "$repository" --ref "$candidate_ref"
  gh workflow run integration.yml --repo "$repository" --ref "$candidate_ref" -f lane=ordinary
  gh workflow run integration.yml --repo "$repository" --ref "$candidate_ref" -f lane=qemu-kvm

  gh run list --repo "$repository" --commit "$candidate_root_sha" \
    --event workflow_dispatch --limit 20 \
    --json databaseId,workflowName,headSha,status,conclusion,url
)
```

Select the **new** run IDs from those dispatches, not an older successful run
at the same SHA. For each run:

```bash
run_id=REPLACE_WITH_NEW_RUN_ID
(
  set -euo pipefail
  test "$(gh run view "$run_id" --repo "$repository" --json headSha --jq .headSha)" = "$candidate_root_sha"
  gh run view "$run_id" --repo "$repository" --json jobs,url
  gh run watch "$run_id" --repo "$repository" --exit-status
)
```

Require both source matrix jobs, `examples-vm`, and the selected job of each
integration run to succeed. The unselected integration job is skipped by design; a skipped
selected job, queued job, cancellation, failure, or timeout is not success.
Retain the exact run URLs and source artifacts
`native-candidate-source-node-{24,26}-<SHA>` and `examples-vm-source-<SHA>`
outside tracked source; retain the corresponding examples VM logs as well. Old failed
runs retain their old workflow/action revisions: re-running their failed jobs
does not test a newly fixed workflow. Dispatch a new run on the corrected ref.

### Remaining verification and publication boundaries

After successful source/integration runs, retain exact-candidate fresh Ubuntu
bootstrap results and actual runtime evidence. Same-host Sysbox/KVM mechanics
are distinct from independently administered multi-host acceptance. Validate
fault/replay/reboot behavior, traffic/guest authority and protected promotion
through the current services; a retired operations marker is not acceptance.
Update a protected QEMU host launcher only through trusted operator review and
deployment; do not change root-owned staged files from an agent to make a
verification run appear successful. Report guest stages and the outer
invocation's final status separately.

Keep the completion status and candidate-specific evidence in external run
records. Runner registration, default-branch promotion, workflow dispatch,
publication, and production deployment require their own operator authority;
the commands here document those actions rather than performing them.

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
