# Scoped auxiliary VM verification receipt

## Source checkpoint

- Base commit: `7cfd44392ffa2e5c92fe00d3b739dc724faa6c7f`.
- Candidate: the commit containing this receipt and its exact read-only source
  bundle; the handoff manifest records the final commit and bundle SHA-256.
- Branch: `feat/validation-followup`.
- Scope: scoped auxiliary-VM discovery/status/console/exec/copy/lifecycle,
  runtime acceptance runner, GitHub/native CI wiring, specifications and guides.

## Source evidence completed

- `pnpm workspace:check`: passed for the complete TypeScript workspace.
- Host core and VM plugin package builds: passed.
- Focused VM access and workflow/policy tests: passed.
- Direct `dim-vm` terminal checks: help exits 0; invalid target exits 2;
  authenticated status returns the grant-filtered target.
- Runtime runner negative preflight: missing exact image bindings fails rather
  than skipping or reporting success.
- The heavy runner rechecks the deterministic VM-access tests before the three
  physical runtime tests, and privileged GitHub execution is limited to the
  reviewed merge queue, `main`/release pushes or explicit manual dispatch.
- The runner forces all three physical tests into required mode so missing
  bindings fail instead of producing skips. The reviewed static KVM ioctl probe
  executes only inside the disposable `container-kvm` workspace test; its
  passing path/outcome is retained in the acceptance receipt.
- Security review fixes included generation-pinned failed-delivery cleanup,
  lifecycle/revoke serialization, held no-follow physical copy ancestry and
  immediate HTTP header dispatch with stdin detachment after response.

These checks use deterministic fakes and local HTTP fixtures where applicable.
They do **not** establish real Incus, KVM, Sysbox or guest-agent behavior.

## Real evidence pending

### Existing runtime tests

Run from the exact clean candidate in the reviewed `container-kvm` validation
workspace or trusted disposable GitHub runner:

```bash
export DIM_VM_ACCEPTANCE_ROOT=/absolute/fresh/private/output
just verify vm-runtime-prepare --run
```

Preparation writes private `bindings.env` and `preparation.json` with the exact
source commit/tree, built workspace image ID, static probe path and SHA-256,
device-enabled state parent and acceptance receipt path. It performs no runner
registration, service installation or credential access.

Success requires all three tests to execute without skips:

- `tests/host/plugins/kvm/runtime.test.ts`
- `tests/host/core/multiRepositoryWorkspaceRuntime.test.ts`
- `tests/host/core/guestIntegrationRuntime.test.ts`

Independent verifier provenance for candidate `79434c2c`: genuine Ubuntu
24.04.5/KVM boot and nested VM-fd creation passed. The first physical run found
two source-relative fixture defects (24 passed, 2 failed); applying the exact
two-line corrections from `runtime-fixture-paths.patch` produced a zero-skip
pass of all eight runner-selected files and 26 tests in 40.37 seconds. This is
capability evidence and fix provenance, not final-candidate acceptance; the new
committed candidate must be rerun and produce its own exact receipt.

### Normal workspace to auxiliary VM

Operator preparation on the selected host:

```bash
dim vm create verifier-vm FULL_REVIEWED_INCUS_FINGERPRINT
dim vm start verifier-vm
dim vm grant verifier-vm VERIFIER_WORKSPACE --lifecycle
```

Verifier commands inside the granted ordinary workspace:

```bash
dim-workspace discovery
dim-vm list
dim-vm status verifier-vm
printf 'stdin-proof' | dim-vm exec verifier-vm -- sh -c 'cat; printf stderr-proof >&2; exit 7'
printf 'binary\000payload' > /tmp/vm-access-input.bin
dim-vm push verifier-vm /tmp/vm-access-input.bin acceptance/input.bin
dim-vm exec verifier-vm -- sha256sum /home/dim/acceptance/input.bin
dim-vm pull verifier-vm acceptance/input.bin /tmp/vm-access-output.bin
cmp /tmp/vm-access-input.bin /tmp/vm-access-output.bin
dim-vm exec verifier-vm -- sh -c 'printf retained > /home/dim/acceptance/retained.txt'
dim-vm stop verifier-vm
dim-vm start verifier-vm
dim-vm exec verifier-vm -- cat /home/dim/acceptance/retained.txt
```

The operator must additionally prove an ungranted workspace has no discovery
entry or credential, revoke the granted workspace during an active command,
observe termination and future denial, then perform exact verifier-owned cleanup.
It must also prove copy-only read/write denial through an intermediate
`/home/dim` symlink while ordinary nested paths succeed; immediate no-input exec
with stdin left open; delayed stdin through EOF; and immediate exec after a
successful start with the `/workspace` and private `/mnt/dim-tmp` image contract.
Record command output, workspace/VM UUIDs, image identity, candidate commit and
artifact hashes. Until both sections have independently returned passing
evidence, this feature remains **waiting for real verification**, not finished.
