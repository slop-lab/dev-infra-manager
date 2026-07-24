# Workspace Runtime Backends

## Scope

Runtime backends define the top-level container runtime and nested engine for a
persistent workspace.

Allowed backend names:

- `sysbox`: `sysbox-runc`, project Docker image, nested Docker.
- `gvisor`: `runsc`, project Docker image, nested Docker with the containerd
  snapshotter disabled.
- `rootless-podman`: `runc`, project Podman image, nested rootless Podman.
- `runc`: privileged `runc`, project Docker image, intended for CI and nested
  development environments.

The selected backend must be stored in workspace metadata and included in the
managed container labels. Reconciliation must reject a container whose backend
label differs from the workspace record.

The nested-engine volume target is `/var/lib/docker` for Docker backends and
`/home/agent/.local/share/containers` for rootless Podman.
Rootless Podman must receive `/dev/fuse` and requires host support for nested
unprivileged user namespaces.

Projects receive `DIM_WORKSPACE_BACKEND` and `DIM_NESTED_ENGINE`. Default
Compose setup must use the selected nested engine.
