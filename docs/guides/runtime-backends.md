# Workspace runtime backends

The base workspace record names the supported backend `container`. The adapter
uses one unprivileged Sysbox agent container and private persistent volumes.
No host backend-selection file or controller is required. Local versus SSH
selects the host transport, independently of this runtime choice.

The host must have Docker access and registered `sysbox-runc`. `dim doctor`
checks these prerequisites; `dim image build` builds the base image. The
[image guide](runtime-images.md) explains image ownership and names.

Optional host plugins supply additional runtimes:

- `@slop-lab/dim-host-plugin-kvm` provides `container-kvm`: the same persistent
  Sysbox workspace with an explicit KVM device grant. It lets workspace tools
  launch their own QEMU VMs without a host Docker socket. Run `dim kvm configure`
  and `dim kvm doctor` on the selected host before choosing this runtime. The
  default `container` runtime continues to reject device injection. See
  [KVM verification from a workspace](../../scripts/development.md#kvm-example-verification-inside-a-workspace).
- `@slop-lab/dim-host-plugin-vm` provides `vm`: an Incus VM workspace, plus
  persistent auxiliary VMs and scoped consoles. It requires an explicitly
  configured Incus project and host resource-budget helper; see its
  [package guide](../../packages/host/plugins/vm/README.md). This is a distinct
  runtime, rather than KVM access inside a Sysbox container.

The [runtime contract](../specs/05-runtime-backends.md) describes the base runtime.
Managed Git adds a scoped source attachment independently of the chosen runtime.
