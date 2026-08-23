# Workspace Runtime Backends

## Scope

Runtime backends define the untrusted agent boundary. The trusted workspace
container is a privileged `runc` container for the default `sysbox` backend;
it owns the Project engine and automatically receives an available
`/dev/kvm`.

Allowed backend names:

- `sysbox`: privileged `runc` workspace plus a host-side, unprivileged
  `sysbox-runc` agent with private Docker.
- `gvisor`: `runsc`, project Docker image, nested Docker.
- `rootless-podman`: `runc`, project Podman image, nested rootless Podman.
- `runc`: privileged `runc`, project Docker image, intended for CI and nested
  development environments.

The selected backend must be stored in workspace metadata and included in the
managed container labels. Reconciliation must reject a container whose backend
label differs from the workspace record.

The agent-engine volume target is `/var/lib/docker` for Docker backends and
`/home/dim/.local/share/containers` for rootless Podman.
All Docker-backed workspace daemons must disable Docker's containerd
snapshotter. Docker 29 stores its containerd image data outside DIM's managed
`/var/lib/docker` volume, and nested snapshotters may discard file capability
xattrs required by Project-owned rootless container engines.
Rootless Podman must receive `/dev/fuse` and requires host support for nested
unprivileged user namespaces. Its outer container must not require
`--privileged`; it must instead receive the specific capabilities that
nested unprivileged user namespaces and mounts need.

When host `/dev/kvm` exists as a character device, supported workspaces may
receive it and its numeric host group as a supplemental group according to the
creation-time KVM policy. Interactive creation recommends but confirms this
grant; automation can explicitly allow or deny it. Detection must not
require the DIM process itself to open the device: the container runtime opens
it, and the supplemental group gives the workspace user access. gVisor does
not receive KVM.

Agent containers are Project-owned workloads, not a core lifecycle resource.
Reviewed `.dim/setup.sh` code may build and start one through the nested
Project engine, while `.dim/entrypoint.sh` maps `dim workspace run` tasks into it. DIM
does not define an agent manifest, image schema, container name, or separate
resource record.

The current `sysbox` installation retains `sysbox-runc` for isolated host
workloads such as managed CI runners. Project-owned containers use the nested
engine and remain within the workspace cgroup boundary.

Projects receive `DIM_WORKSPACE_BACKEND` and `DIM_NESTED_ENGINE`. Default
Compose setup must use the selected nested engine.
