> Scope: optional managed Project workspace runtime, separate from the base
> single-container workspace. Commands below require `dim managed`.

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

Recommended CPU, memory, and PID values are one combined budget. DIM assigns
the integer floor of 25 percent to trusted runc infrastructure and the exact
remainder to the Sysbox agent. The minimum is 1 CPU, 1 GiB memory, and 256 PIDs;
each container's swap limit equals its memory limit. Resource updates verify
exact readback before state publication and roll back every attempted change on
failure, reporting an uncertain state if rollback cannot be proved.

Custom Project-owned services share the outer-workspace budget unless Compose
adds stricter child limits. Their nested Docker state is persisted in DIM's
outer managed `/var/lib/docker` engine volume. Custom `discard --keep-volume
--yes` retains that volume for same-name recreation and signals custom Project
teardown to retain intended nested named data. Recommended mode instead owns
separate home, checkout, and private-Docker volumes: its `--keep-volume` request
is rejected before any mutation. Leave the recommended workspace intact or
copy needed data before ordinary full discard. External volumes remain
Project-owned outside either store.

KVM is optional and independent of Sysbox readiness. When available and
approved at workspace creation, DIM forwards `/dev/kvm` and its numeric group.

Projects receive `DIM_WORKSPACE_BACKEND=sysbox` and
`DIM_NESTED_ENGINE=docker`.
