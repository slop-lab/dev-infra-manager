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
- Security review fixes included generation-pinned failed-delivery cleanup,
  lifecycle/revoke serialization and pre-resolution symlink rejection.

These checks use deterministic fakes and local HTTP fixtures where applicable.
They do **not** establish real Incus, KVM, Sysbox or guest-agent behavior.

## Real evidence pending

### Existing runtime tests

Run from the exact clean candidate in the reviewed `container-kvm` validation
workspace:

```bash
export DIM_TEST_KVM_IMAGE=sha256:REVIEWED_LOCAL_IMAGE_ID
export DIM_TEST_KVM_STATE_PARENT=/private/non-symlink/state-parent
export DIM_TEST_KVM_PROBE=/absolute/reviewed/kvm-ioctl-probe
export DIM_NATIVE_MULTI_REPOSITORY_IMAGE=sha256:REVIEWED_LOCAL_IMAGE_ID
export DIM_GUEST_INTEGRATION_IMAGE=sha256:REVIEWED_LOCAL_IMAGE_ID
export DIM_VM_ACCEPTANCE_RECEIPT=/absolute/private/vm-runtime-acceptance.json
just verify vm-runtime-acceptance
```

Success requires all three tests to execute without skips:

- `tests/host/plugins/kvm/runtime.test.ts`
- `tests/host/core/multiRepositoryWorkspaceRuntime.test.ts`
- `tests/host/core/guestIntegrationRuntime.test.ts`

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
Record command output, workspace/VM UUIDs, image identity, candidate commit and
artifact hashes. Until both sections have independently returned passing
evidence, this feature remains **waiting for real verification**, not finished.
