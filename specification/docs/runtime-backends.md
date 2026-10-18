# Workspace runtime backends

The base workspace record names the supported backend `container`. The adapter
uses one unprivileged Sysbox agent container and private persistent volumes.
No host backend-selection file or controller is required. Local versus SSH
selects the host transport, independently of this runtime choice.

The host must have Docker access and registered `sysbox-runc`. `dim doctor`
checks these prerequisites; `dim image build` builds the base image. The
[image guide](runtime-images.md) explains image ownership and names.

VM support remains future work. The [runtime contract](../specs/05-runtime-backends.md)
describes current behavior without reserving an unimplemented VM schema.
Managed Project environments retain their separate
[runtime implementation](../../core/packages/managed/docs/workspace-runtime.md).
