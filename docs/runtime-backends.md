# Workspace Runtime Backends

The host backend installer records its selection as `workspaceBackend` in the
DIM user configuration. DIM uses that installed backend for new workspaces and
stores it in each workspace record.

The supported backends are:

| Backend | Outer runtime | Nested engine | Intended use |
| --- | --- | --- | --- |
| `sysbox` | privileged `runc` workspace | Docker | Current system-container host support |
| `gvisor` | `runsc` | Docker | No-KVM sandboxed fallback |
| `rootless-podman` | `runc` | Podman | Lower-privilege Podman-compatible workloads |
| `runc` | privileged `runc` | Docker | Nested development containers and CI only |

The backend is immutable for the lifetime of a workspace. Create a new
workspace to change it. `show` reports the persisted selection.

With the current `sysbox` backend, trusted Project lifecycle code and its
Docker daemon run in a privileged runc workspace. A repository may create an
agent as an ordinary nested Compose service with its own DinD volume and no
Docker socket mount. That separation is useful operationally but is not a
strong security boundary inside the privileged workspace. Future executors
may provide stronger container or QEMU isolation without changing the
Project-owned setup and entrypoint contract.

`rootless-podman` requires `/dev/fuse` and a host that permits nested
unprivileged user namespaces. Its outer container runs unprivileged, with a
specific capability set (`SYS_ADMIN`, `SETUID`/`SETGID`, `SYS_CHROOT`,
`SYS_PTRACE`, and the rest of the set shared with `gvisor`) granted instead;
Docker's seccomp, AppArmor, and masked/read-only system-path confinement is
disabled so the nested rootless runtime can create user namespaces and mount
its own procfs;
set `DIM_WORKSPACE_PRIVILEGED=true` to fall back to a fully privileged outer
container if a host's kernel/seccomp configuration needs it. `dim doctor`
checks the configured backend's device and image requirements, but creation is
the definitive host compatibility test.

`DIM_WORKSPACE_IMAGE`, `DIM_WORKSPACE_RUNTIME`, and
`DIM_WORKSPACE_PRIVILEGED` are advanced image/runtime overrides; they do not
change the backend stored in workspace metadata.

CPU, memory, and PID limits apply to the workspace boundary. Nested
Project-owned services share that budget unless their Compose definition adds
stricter child limits. DIM does not impose a per-workspace disk quota.
`discard --yes` removes the workspace container and its nested-engine storage
volume. `discard --keep-volume --yes` retains the labeled DIM-managed volume;
recreating the same workspace name reuses it after label validation.
Docker-backed workspaces disable Docker's containerd image store so all nested
engine state remains in that managed `/var/lib/docker` volume. This also avoids
losing file capability metadata when images are unpacked through nested
snapshotters. Official rootless-DinD examples additionally install the
`newuidmap` and `newgidmap` setuid fallback.
Environment values provide creation defaults; individual workspaces can store
different limits through `dim workspace create` resource options.

Projects using `.dim/setup.sh` can inspect `DIM_WORKSPACE_BACKEND` and
`DIM_NESTED_ENGINE`. The default `.dim/docker-compose.yml` setup uses
`docker compose` for Docker backends and `podman compose` for
`rootless-podman`.
