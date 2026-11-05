# Scoped workspace access to auxiliary VMs

This plan extends the optional host VM plugin so an ordinary running workspace
can discover and use an operator-granted auxiliary VM without receiving host,
Incus, Docker, SSH, or control-plane credentials. Auxiliary VMs remain separate
from core workspace records and retain their own UUID, reviewed image, resource
limits, durable disk, and exact Incus ownership labels.

## Authority model

An operator creates and configures auxiliary VMs through `dim vm`. A workspace
grant binds the current workspace UUID, VM UUID/name, a random grant ID and an
explicit permission set:

- `discover` and `status` expose only grant-filtered identity and running state;
- `console` retains the scoped SPICE browser path;
- `exec` permits ordinary commands inside the selected VM as user `dim`;
- `copy` permits bounded transfer below `/home/dim` using the existing DIMCP1
  archive/path/symlink limits;
- `lifecycle` permits only start and stop.

Creation, image import, discard, allocation, host resource changes, root exec,
arbitrary Incus queries and provisioning remain operator-only. Revocation,
workspace stop/discard/name reuse, VM identity change, or VM removal invalidates
new requests and aborts active streams.

## Transport and guest workflow

The VM plugin declares a `vm` workspace service. The workspace service channel
provides transport only; the VM plugin's host-owned loopback server performs
grant authorization and operation dispatch. The guest receives a private
credential containing only the VM/grant identities, permissions, scoped token,
console URL and the fixed `vm` service endpoint.

The plugin deploys `dim-vm` for OpenCode, Codex, Claude and ordinary shell use:

```text
dim-vm list
dim-vm status NAME
dim-vm exec NAME -- COMMAND...
dim-vm push [--recursive] [--overwrite] NAME LOCAL_PATH VM_PATH
dim-vm pull [--recursive] [--overwrite] NAME VM_PATH LOCAL_PATH
dim-vm start NAME
dim-vm stop NAME
```

Exec uses framed stdout/stderr/exit responses, request-body stdin, connection
close cancellation and Incus streaming exec. Copy uses the checked-in DIMCP1
guest helper and cancellation cleanup rather than arbitrary host paths or raw
`incus file` arguments. Generic workspace discovery exposes grant-filtered
targets and operation-specific availability; absent `/dev/kvm` in the current
workspace does not hide an attached auxiliary VM.

## Implementation order

1. Version the persisted grant shape while accepting legacy console-only grants.
2. Add `VmAccessService` for authorization, discovery, status, exec, copy and
   bounded lifecycle operations.
3. Add the loopback VM access server and plugin `workspaceServices` resolver.
4. Deploy the guest CLI/copy helper and publish guest operations/capabilities.
5. Add deterministic grant, identity, streaming, copy, revoke and name-reuse
   tests before real runtime acceptance.
6. Add one hard-fail runtime acceptance runner for the KVM, multi-repository
   Sysbox and guest-integration tests with exact image/probe receipts.
7. Wire the heavy runner to main/merge/release acceptance without adding it to
   every development push.

## Runtime acceptance

The real acceptance path is:

```text
ordinary workspace agent -> granted auxiliary Ubuntu VM -> build/test ->
artifact copied back -> revoke/stop/reconnect/name-reuse denial -> exact cleanup
```

The reusable runner must fail unavailable when KVM, Sysbox, reviewed image IDs,
the private state parent or the static KVM ioctl probe is missing. A skipped
Vitest case is not successful required evidence. The operator-provided
`container-kvm` validation workspace is execution tooling for this runner, not
the normal auxiliary-VM access architecture.

## Current checkpoint and verifier handoff

The source implementation, deterministic tests, package builds and CI wiring
are complete in the branch containing this plan. They are not real Incus/KVM
acceptance. The current source receipt is
[`vm-access-verification.md`](vm-access-verification.md); it deliberately marks
both hardware lanes as pending until independently observed evidence is
returned for the exact committed candidate.

The delegated verifier needs two distinct journeys:

1. Run `just verify vm-runtime-prepare --run` in the operator-created
   `container-kvm` workspace or trusted disposable GitHub runner. Preparation
   builds and inspects the exact workspace image, compiles and hashes the fixed
   KVM probe, selects private device-enabled state and passes explicit bindings
   to the existing KVM, multi-repository Sysbox and guest-integration tests.
2. From a normal ordinary workspace, use an operator-created auxiliary VM via
   `dim-workspace discovery` and `dim-vm`. Verify filtered discovery, status,
   stdin/stdout/stderr/exit, signal cancellation, binary push/pull, optional
   stop/start reconnect and retained data. A second ungranted workspace must
   not discover or use the target. Revoke the exact grant during an active exec
   and verify stream termination plus future denial. Cleanup must discard only
   verifier-created workspace/VM resources after evidence has been retained.

The operator performs provisioning, grant/revoke and exact-resource cleanup.
The verifier receives no Incus socket, host credential or another workspace's
private VM credential. Root publication and installed policy activation remain
separate coordinator actions.

Native repository CI currently supports one repository-wide required job set
and no candidate environment/profile declarations. Requiring QEMU there would
gate ordinary `development` candidates while leaving physical bindings
undefined; trusted acquisition also supplies source trees without `.git`, while
the runtime receipt deliberately binds a canonical commit/tree. The reviewed
Native policy therefore remains source-only. Heavy runtime acceptance is scoped
to trusted GitHub merge/main/release/manual contexts and remains directly
runnable from an exact ordinary Git workspace.

## Deferred boundaries

GPU access, arbitrary host mounts, repository-controlled setup scripts and broad
central VM control remain deferred. This plan does not add a host shell, host
Docker/Incus socket, raw operator SSH key, caller-selected QEMU arguments,
unreviewed image selection, arbitrary host paths or universal remote execution.
