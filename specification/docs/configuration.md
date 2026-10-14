# Configuration

Set `DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE` to the absolute private native
host connection before Project or workspace commands. `project create` also
requires `DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE`. Both files are
caller-owned, single-link, non-symlink, mode `0600`, and use distinct roles.

Predecessor provider, sync, scheduler, and ordinary-pool selectors are rejected.
There is no implicit managed service and no fallback.

Workspace backend configuration accepts only `workspaceBackend: "sysbox"` in
this release. Ordinary and QEMU host/scheduler files are separate global
operator configuration. They bind immutable digest-pinned images and bounds;
candidate bytes cannot override them.

See [`../specs/03-configuration.md`](../specs/03-configuration.md) for exact
contracts.
