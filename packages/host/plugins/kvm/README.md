# Explicit KVM workspace access

This optional host plugin provides the `container-kvm` runtime. Install it on
an explicitly trusted Linux KVM host, then run `dim kvm configure` and
`dim kvm doctor`. Create a verification workspace with
`dim create SOURCE NAME --runtime container-kvm`.

Configuration uses the reviewed local workspace image, pinned to its inspected
Docker image ID, in a disposable runc container. Only the private plugin state
directory is writable. The helper has no network, a read-only root and only
MKNOD and DAC_OVERRIDE capabilities. It creates one root-owned 10:232 device
node with mode 0666 behind an operator-owned mode 0700 directory. The host's
original `/dev/kvm` permissions remain unchanged. The workspace receives this
node as `/dev/kvm` with read/write access, without host Docker sockets or host
configuration mounts. Ordinary container workspaces receive no devices.

KVM exposes a host kernel interface and is an explicit operator grant. Only
use it for trusted disposable verification infrastructure. QEMU, cloud-image
preparation and test-specific control-plane/host VM separation belong to the
reviewed repository tooling. No guest OS or credentials are provisioned by
this plugin. `doctor` requires host Python 3 and actually creates a KVM VM file
descriptor; a device-file permission check alone is not acceptance.
