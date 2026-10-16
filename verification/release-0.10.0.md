# Internal development preparation: 0.10.0

This is a pre-stable internal-development target, not a stable release or an
announcement of registry availability. The production manifests, exact DIM
dependency/peer pins, lockfile, source version constants, and current examples
are aligned to `0.10.0`. Changelogs remain unreleased.

## Candidate identity

The runtime-tested code candidate is
`2804eeab6d17766ce84abf90ce5ceef4ceda27b4`, tree
`fe92b7e947da230c716392f1614fa4c8e1b64c3a`.
Its source was supplied as a complete Git bundle; the disposable driver and
both fresh guests verified the exact commit and tree before installation.
The source checkout was clean. Later documentation-only commits record these
results; they are not additional runtime-tested artifact identities.

## Observed verification

| Surface | Result |
| --- | --- |
| Pinned isolated Node.js 24 source gate at the tested candidate | Passed type checks, all package builds, 2,094 unit tests, 157 CLI tests, and 547 verification tests; one existing conditional unit skip |
| Ten production package dry-runs | Passed at `4c95a1a2`; the publishable production inputs are unchanged between that commit and the tested candidate; each listing contains README, LICENSE, and package metadata |
| Fresh Ubuntu ordinary bootstrap | Passed first-login status 3, new-login resume, exact source/package/tool checks, durable packed facade, controller/plugin activation, and real Sysbox execution |
| Fresh Ubuntu control-QEMU bootstrap | Passed the same journey plus KVM device access and QEMU tool provisioning |
| Full packed control-plane lifecycle in the new control VM | Passed install, update, rollback/recovery, role/state refusal, and owned fixture cleanup |
| Native workspace lifecycle in both the outer and fresh control guests | Passed proposal-only Git, protected-write denial, retained checkout across stop/start/restart/update, and cleanup |
| Workspace verification capabilities | Passed private Docker readiness and absence of direct `/dev/kvm`, a default QEMU broker mount, or its environment grant |
| Native ordinary Sysbox and QEMU KVM mechanics | Passed real execution, without TCG substitution |
| Disposable guest aggregate | All ten stages passed; no failed or blocked guest stage |
| Shell syntax and whitespace | Passed |

The first packed-plugin smoke inherited this agent's mounted proxy environment
and failed with `EROFS` at `/run/dim/controller-proxy/resources.sock`. The same
artifacts and unchanged smoke passed with a clean process environment. No
mounted socket was changed.

The final broker run started at `2026-10-16T05:37:09.643Z` and finished at
`2026-10-16T06:12:18.618Z`. The successful guest summary was
`passed=10 failed=0 blocked=0`, including `fresh-ubuntu-bootstrap-smoke-ok`.
The fresh-VM success marker is emitted only after both owned QEMU processes,
overlays, seeds, and temporary key directories have been retired and removed.

The same run's **outer service status was failure**, exit 1: after all ten guest
stages, the separately root-staged older launcher invoked removed `--repos`
input. That protected host closure was not changed. The successful guest
results must not be described as a successful complete outer invocation.

Relevant local logs are:

- `.local/verification/0.10.0-qemu-bootstrap-2804eeab.log`
- `.local/verification/0.10.0-source-2804eeab.log`
- `.local/verification/0.10.0-package-packs-4c95a1a2.log`

These logs are not release package contents or independent-host acceptance
evidence. Earlier failed runs exposed and locked regressions for the actual
Sysbox Debian version, guest transport ownership, source-build prerequisites,
and private Git creation under Ubuntu's group-writable `umask 0002`. Git now
creates private metadata independently of umask; durable checks remain strict,
and changed or missing creation policy is rejected rather than repaired.

## Verification from a workspace

The recommended 0.10 workspace has a working private nested Docker daemon, but
does not receive direct KVM or a QEMU broker automatically. A reviewed Project
may expose its fixed protected verification task, as this Project does; the
agent requests it through `.dim/qemu-client.mjs`, not a host Docker socket or an
arbitrary host command. Native global QEMU CI is a separate operator deployment.
Successful brokered execution does not make bootstrap a supported direct
operation on the untrusted agent's own OS.

## Unavailable and remaining checks

- A trusted operator must review and redeploy the protected host QEMU closure
  before claiming an all-success outer service status. Do not replace those
  root-owned staged files from an agent or reintroduce obsolete CLI aliases.
- The current agent itself still lacks direct KVM and the parent daemon's bind
  socket. The previously unavailable control-plane gate was completed in the
  disposable VMs, not by exposing either host capability to the agent.
- The current two-role guests and same-host mechanics do not replace a new
  configured two-node operations run, administrative independence, fault/reboot
  acceptance, interactive human review, or checked protected-ref promotion.
  The earlier `7ca8663c` two-node report is not evidence for this candidate.
- Node.js 26 was not re-run in this preparation. The bootstrap's selected
  internal toolchain is explicitly Node.js 24.19.0.
- The LSP daemon was unavailable. Workspace TypeScript checks and executable
  tests passed instead; no clean LSP result is claimed.

TLS, private native role files, lingering, worker activation, and human protected
ref approval remain operator-owned. Full independent-host/public acceptance is
separate from this internal preparation. No release tag, public package
publication, public image publication, or persistent host deployment was made.
