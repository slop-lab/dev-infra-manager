# QEMU execution backend

QEMU is an execution backend of the shared job service. It has the same
execution aggregate, worker leases, journals, result publication and cleanup
fencing as Sysbox. There is no separate QEMU scheduler, authority, event store
or evidence-proof chain. A QEMU CI guest is not a persistent development VM.

The operator configures QEMU slots and reviewed runner/job image digests in the
execution service. A private host file selects matching slots and credentials.
`dim ci worker FILE` checks Docker and access to a real `/dev/kvm`
before claiming work. Missing KVM is unavailable; TCG and ordinary execution
cannot be substituted. Build the trusted supervisor with `dim ci
qemu-image IMAGE:TAG`, then select its reviewed deployed digest.

The backend verifies exact candidate configuration/script bytes and descriptor
before launch. Candidate content controls its script and fixed compiled argv;
it cannot choose host commands, images, devices, mounts, networks or credentials.
The supervisor is an owned bounded container running as the worker UID/GID with
the KVM device group, all capabilities dropped and no-new-privileges. Its memory
limit includes the guest bound plus 256 MiB of supervisor overhead.

Job metadata/script and the guest-root image are read-only mounts. The writable
workspace uses mapped-xattr 9p metadata so guest ownership changes do not change
host ownership. Guest code runs without a network device or reusable operator
credential. Host-side private acquisition material is outside guest mounts.

Wall time, output bounds, cancellation, process observation and exact owned
cleanup produce the shared terminal result. Failed or uncertain cleanup keeps
capacity fenced. Guest termination alone does not prove all supervisor resources
were removed. A result is candidate-controlled and cannot approve or promote
source.

Verify launcher/guest behavior on real KVM separately from deterministic queue,
resource, cancellation and ownership tests. A missing device, mocked process or
root-container ownership test cannot establish physical KVM mechanics. See
[execution setup](../../guides/ci-runners.md) and [verification](../12-verification.md).
