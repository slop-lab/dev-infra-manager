# Native verification and cutover

## Automated same-host mechanics

Run only on a disposable Linux host with Docker, `sysbox-runc`, and accessible
real KVM:

```bash
bash verification/scripts/kvm-guest-verification-smoke.bash
```

The aggregate independently runs native contract tests, installed native Git
and ordinary-CI bundle checks, one real native Project and persistent Sysbox
workspace lifecycle, one real Sysbox job, and one real KVM guest job. The
lifecycle phase builds an isolated workspace image, starts loopback native Git
and controller fixtures, creates its Project and workspace in temporary state,
and removes its exact workspace resources and image before reporting success.

The aggregate records mode-`0600` phase logs plus `PASS`, `FAIL`, and `BLOCKED`
status. Cancellation reaches the active process group. Exit `125` means cleanup
is uncertain. Missing KVM or Sysbox is unavailable (`2`), never a pass.

This same-host result is mechanics evidence. It is not independent-host
verification, human approval, protected-ref promotion, or full release
acceptance.

## Operator deployment smoke

For separately configured hosts, copy the literal mode-`0600` fixture and run:

```bash
cp verification/native-cutover-clean-host.conf.example /absolute/operator/native-cutover.conf
bash verification/scripts/native-cutover-clean-host.bash --preflight-only \
  /absolute/operator/native-cutover.conf
bash verification/scripts/native-cutover-clean-host.bash \
  /absolute/operator/native-cutover.conf
```

The smoke uses fixed harness commands only. Role files remain on their owning
host and never enter argv or evidence. It bootstraps a native root, creates a
ready Project/workspace before CI, proves proposal and protected-ref denials,
runs ordinary and QEMU jobs, and requires an interactive operator confirmation
before approval and checked promotion.

Its atomic `SMOKE-PASSED` marker remains explicitly below
`VERIFICATION-NATIVE-CUTOVER-001`. Full acceptance additionally requires
independently administered ordinary and QEMU hosts, effective traffic and guest
authority inspection, crash/reboot recovery, the complete failure/stale/replay
matrix, and recorded human review.

## Existing state

Use the pinned prior release to stop predecessor services and export required
user data. Native installation does not discover, adopt, migrate, delete, or
rename existing provider containers, volumes, remotes, repositories, or
credentials. Destroy disposable verification nodes only after evidence and
exports are retained.
