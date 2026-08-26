# Workspace Runtime Backend

## Scope

DIM supports one workspace backend: `sysbox`. Backend selection is therefore
not a Project extension point.

The trusted workspace infrastructure container is a privileged Docker
container using the host's ordinary `runc` runtime. It owns the Project engine,
reviewed setup process, controller grant, and any secret-bearing services. The
untrusted agent runs separately in a host-side, unprivileged `sysbox-runc`
container with private rootless Docker. Running trusted infrastructure with
`runc` is an internal implementation dependency, not a selectable workspace
isolation backend.

Workspace metadata and managed-container labels MUST record `sysbox`.
Configuration or existing state naming any other backend MUST be rejected;
DIM does not provide compatibility aliases or state migration for removed
pre-stable backends.

DIM persists the trusted Project Docker engine at `/var/lib/docker`. The daemon
MUST disable Docker's containerd snapshotter because Docker 29 otherwise keeps
image data outside that managed volume.

When host `/dev/kvm` exists as a character device, a workspace may receive it
and its numeric host group according to the creation-time KVM policy. KVM is an
optional workspace capability and MUST NOT be required by Sysbox installation
or backend doctor checks.

Agent containers are Project-owned workloads, not core lifecycle resources.
Reviewed `.dim/setup.sh` code may build and start one through the nested Project
engine, while `.dim/entrypoint.sh` maps `dim workspace run` tasks into it. DIM
does not define an agent manifest, image schema, container name, or separate
resource record.

Projects receive `DIM_WORKSPACE_BACKEND=sysbox` and
`DIM_NESTED_ENGINE=docker`. Project-owned containers remain within the
workspace resource boundary.
