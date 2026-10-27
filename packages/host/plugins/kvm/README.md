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
Controller-backed workspace routes use the runtime recorded on the workspace;
for `container-kvm`, route resolution re-inspects the container through that
selected runtime and rejects any change to the exact device node, mount mode or
10:232 cgroup grant before publishing the route.

KVM exposes a host kernel interface and is an explicit operator grant. Only
use it for trusted disposable verification infrastructure. QEMU, cloud-image
preparation and test-specific control-plane/host VM separation belong to the
reviewed repository tooling. No guest OS or credentials are provisioned by
this plugin. `doctor` requires host Python 3 and actually creates a KVM VM file
descriptor; a device-file permission check alone is not acceptance.
Unit and disposable controller-route checks prove runtime selection and exact
inspection behavior, but they do not prove that Sysbox can expose KVM or create a
VM. That evidence still requires `dim kvm doctor` and a disposable
`container-kvm` workspace on a privileged KVM-capable Linux host.

## Guest discovery and verification

`dim-workspace discovery` reports this owner's current `direct-access` and
`vm-fd-verification` capabilities. An ordinary container reports
`blocked` / `runtime-grant-required`, not an absent or unsupported host KVM
device. The minimal operator action is to prepare and explicitly select a
separate `container-kvm` verification workspace using the commands above.
Discovery never configures KVM, grants a device, changes a firewall, or replaces
the current workspace. There is no implicit host-VM delegation route.

For an explicitly granted workspace, discovery checks the device identity,
read/write permission and KVM API inside that workspace. Missing devices,
permission denial, unavailable Python 3, and runtime connectivity failure remain
distinct blocked/unavailable conditions rather than an invented usable path.
When `vm-fd-verification` is available, run:

```sh
dim-workspace plugin kvm verify '{}'
```

The fixed operation accepts no selectors, commands or paths. It creates and
closes one KVM VM file descriptor inside the authenticated workspace, with a
bounded deadline and immutable identity check. A successful response reports
`effect: "vm-fd-created-and-closed"`; it does not prove a guest OS boot,
vCPU execution or repository test-suite success. Repository tools still own
those larger validations. No host command, host device grant or operator
credential is exposed by the operation.
