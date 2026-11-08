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
limit includes the guest bound plus 256 MiB of supervisor overhead for small
QEMU guests. The full Ubuntu hardware profile below reserves 1 GiB of outer
headroom for QEMU, its supervisor and container kernel costs, without increasing
the guest memory bound. Operator host and capacity-pool reservations MUST include
that outer allowance for every slot, plus the separate worker supervisor and
other host services. The execution scheduler does not derive this allowance
from an image label or raise an operator reservation automatically.

Job metadata/script and the guest-root image are read-only mounts. The writable
workspace uses mapped-xattr 9p metadata so guest ownership changes do not change
host ownership. Guests use user-mode networking without reusable operator credentials. Small
QEMU guests have no host port forwarding; the explicit full Ubuntu profile
below adds a temporary host-loopback emergency SSH endpoint. Host-side private acquisition material is outside guest mounts.

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
`io.dim.execution.runner-profile=ubuntu-hardware-v2`. This mode MUST require the
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
When canonical verification transfers this database through a Git bundle, its
source manifest MUST explicitly carry `boundedParents`. Operator validation and
every fresh guest import MUST match the ordered list to all raw candidate parent
headers, reject additional commit objects, restore only those boundaries and run
strict full object verification. A bundle alone does not preserve shallow
metadata. Full-history input omits this field; missing ancestors MUST NOT be
silently accepted, synthesized or fetched beyond the reviewed context.

The full guest runs the candidate in its own systemd unit with its task limit
and normal guest sudo. Host CPU/memory and supervisor PID limits remain
enforced outside the VM. A private virtio channel MUST preserve the actual
exit code and agree with QEMU termination; bootstrap success is not job success.
The fixed job artifact directory is `/workspace/.dim-ci-artifacts`; only that
share returns candidate evidence, never the private hypervisor disks.

## Emergency operator SSH for full hardware verification

The explicit Ubuntu hardware profile MUST provision emergency SSH by default.
The trusted worker MUST generate fresh per-attempt login and guest server keys
under its exact owned private hardware root. Only the login public key and this
guest's server identity MAY enter cloud-init. Reusable host credentials, login
private keys and host sockets MUST remain outside all guest shares. Password
and root login MUST be disabled; SSH MUST start before dependency bootstrap.

The owned supervisor MUST publish an ephemeral SSH port on the actual execution
host's127.0.0.1 interface only, with a fixed supervisor-to-guest22 forward.
Host-network and network-none configurations MUST fail closed for this profile.
The trusted operator discovery command MUST validate the private worker config,
current exact assignment/root identity and the exact owned running container
and loopback publication. It MUST NOT accept a candidate-selected path, key,
port or privilege. It returns only connection metadata; the generated private
SSH configuration MUST pin the fresh guest host key and disable agent forwarding.
Remote access uses the selected host's normal trusted operator SSH transport.

Emergency access MUST NOT extend lease, deadline, resource or cleanup lifetime.
Existing exact owned container/root cleanup MUST remove the endpoint and its
private access material. Failed or uncertain cleanup remains fenced under the
normal worker contract. Small QEMU and Sysbox are unchanged.
