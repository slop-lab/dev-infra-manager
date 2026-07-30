# Workspace Runtime Backends

## Scope

Runtime backends define the untrusted agent boundary. The trusted workspace
container is a privileged `runc` container for the default `sysbox` backend;
it owns the Project engine and automatically receives an available
`/dev/kvm`.

Allowed backend names:

- `sysbox`: privileged `runc` workspace plus a host-side, unprivileged
  `sysbox-runc` agent with private Docker.
- `gvisor`: `runsc`, project Docker image, nested Docker with the containerd
  snapshotter disabled.
- `rootless-podman`: `runc`, project Podman image, nested rootless Podman.
- `runc`: privileged `runc`, project Docker image, intended for CI and nested
  development environments.

The selected backend must be stored in workspace metadata and included in the
managed container labels. Reconciliation must reject a container whose backend
label differs from the workspace record.

The agent-engine volume target is `/var/lib/docker` for Docker backends and
`/home/dim/.local/share/containers` for rootless Podman.
Rootless Podman must receive `/dev/fuse` and requires host support for nested
unprivileged user namespaces. Its outer container must not require
`--privileged`; it must instead receive the specific capabilities that
nested unprivileged user namespaces and mounts need.

When host KVM is accessible, rootless Podman additionally receives
`/dev/kvm` and its numeric host group as a supplemental group. gVisor does not
receive KVM.

For `sysbox`, `.dim/agent.json` is trusted root-repository configuration. DIM
builds its relative `buildContext`, creates a separate checkout volume, and
maps named tasks to fixed command arrays. `dim run` executes those tasks
directly through the host-side agent daemon. The agent receives neither the
host-side daemon socket nor the Project daemon socket.

The host-side DIM daemon must have `sysbox-runc` registered. The nested Project
daemon must not require Sysbox registration.

Projects receive `DIM_WORKSPACE_BACKEND` and `DIM_NESTED_ENGINE`. Default
Compose setup must use the selected nested engine.
