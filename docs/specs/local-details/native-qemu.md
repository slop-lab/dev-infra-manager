# QEMU execution backend

QEMU is an execution backend of the shared job service. It has the same
execution aggregate, worker leases, journals, result publication and cleanup
fencing as Sysbox. There is no separate QEMU scheduler, authority, event store
or evidence-proof chain. A QEMU CI guest is not a persistent development VM.

The operator configures QEMU slots and reviewed runner/job image digests in the
execution service. A private host file selects matching slots and credentials.
`dim execution worker FILE` checks Docker and access to a real `/dev/kvm`
before claiming work. Missing KVM is unavailable; TCG and ordinary execution
cannot be substituted. Build the trusted supervisor with `dim execution
qemu-image IMAGE:TAG`, then select its reviewed deployed digest.

The backend verifies exact candidate configuration/script bytes and descriptor
before launch. Candidate content controls its script and fixed compiled argv;
it cannot choose host commands, images, devices, mounts, networks or credentials.
The supervisor is an owned bounded container running as the worker UID/GID with
the KVM device group, all capabilities dropped and no-new-privileges. Its memory
limit includes the guest bound plus 256 MiB of supervisor overhead.

Job metadata/script and the guest-root image are read-only mounts. The writable
workspace uses mapped-xattr 9p metadata so guest ownership changes do not change
host ownership. Guests use user-mode networking without host port forwarding or reusable operator
credentials. Host-side private acquisition material is outside guest mounts.

Wall time, output bounds, cancellation, process observation and exact owned
cleanup produce the shared terminal result. Failed or uncertain cleanup keeps
capacity fenced. Guest termination alone does not prove all supervisor resources
were removed. A result is candidate-controlled and cannot approve or promote
source.

Verify launcher/guest behavior on real KVM separately from deterministic queue,
resource, cancellation and ownership tests. A missing device, mocked process or
root-container ownership test cannot establish physical KVM mechanics. See
[execution setup](../../guides/ci-runners.md) and [verification](../12-verification.md).

## Explicit full Ubuntu hardware profile

An operator-pinned runner image MAY declare
`io.dim.execution.runner-profile=ubuntu-hardware-v1`. This mode MUST require the
identical immutable runner/job image digest, at least 4 CPU and 20 GiB memory,
and a three-hour wall budget. Unknown labels MUST fail closed. It MUST NOT be
selected by candidate environment or a repository image reference. Small QEMU
and Sysbox behavior remains independent.

The full systemd guest owns private disk overlays and a fixed 64 GiB scratch
disk, with at least 24 GiB available to the canonical gate. Worker state MUST be
disk-backed with at least 80 GiB free; supervisor disk files MUST remain outside
all guest-visible shares. The guest MUST create and close a real nested KVM VM
from its job user before candidate execution; TCG cannot substitute. Package
setup MUST retain signed-index verification, bounded failure/retry and the
selected trusted mirror routing. Bootstrap failure MUST terminate with its
bounded exit receipt instead of waiting for the job deadline.

Only this trusted profile MAY request the optional bounded source context. It
uses the existing repository-scoped lease, whose server upload-pack boundary is
repository scope, and narrows acquisition in the trusted reader to the exact
candidate and at most eight distinct immediate parents cryptographically named
by its raw commit. All materialized inputs/context share the existing 256 MiB
budget. No older ancestor, ref catalog, remote configuration, askpass script or
credential is exported. Ordinary acquisition stays candidate-only and contains
no Git metadata. Exported raw commits/trees MUST be verified before use.

Public descriptor, script, configuration and source-context files MUST have
explicit readable modes independent of worker umask/UID; nested public
directories MUST be traversable by the guest job UID. Preserve Git executable
identity. The outer worker root, hardware disks, credentials and artifact
pending storage MUST remain private. The guest job may reconstruct an exact
local shallow object database from this context; it grants no source authority.

The full guest runs the candidate in its own systemd unit with its task limit
and normal guest sudo. Host CPU/memory and supervisor PID limits remain
enforced outside the VM. A private virtio channel MUST preserve the actual
exit code and agree with QEMU termination; bootstrap success is not job success.
The fixed job artifact directory is `/workspace/.dim-ci-artifacts`; only that
share returns candidate evidence, never the private hypervisor disks.
