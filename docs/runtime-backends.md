# Workspace Runtime Backend

DIM supports Sysbox as its only workspace backend. The host installer records
`workspaceBackend: "sysbox"`, and each workspace record and managed-container
label carries the same value. Obsolete backend configuration and state are
rejected rather than migrated.

The trusted Project workspace and its Docker daemon run in a privileged
container using Docker's ordinary runc runtime. The untrusted agent runs in a
separate unprivileged `sysbox-runc` container with private rootless Docker.
Thus runc remains a host implementation dependency but is not a selectable
workspace backend.

`DIM_WORKSPACE_IMAGE`, `DIM_WORKSPACE_RUNTIME`, and
`DIM_WORKSPACE_PRIVILEGED` are advanced trusted-infrastructure overrides; they
do not change the recorded Sysbox backend.

CPU, memory, and PID limits apply to the workspace boundary. Nested
Project-owned services share that budget unless their Compose definition adds
stricter child limits. Nested Docker state is persisted in the managed
`/var/lib/docker` volume. `discard --keep-volume --yes` retains that volume for
reuse when the workspace is recreated.

KVM is optional and independent of Sysbox readiness. When available and
approved at workspace creation, DIM forwards `/dev/kvm` and its numeric group.

Projects receive `DIM_WORKSPACE_BACKEND=sysbox` and
`DIM_NESTED_ENGINE=docker`.
