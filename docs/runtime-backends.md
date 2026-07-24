# Workspace Runtime Backends

DIM stores the selected runtime backend in each workspace record. Choose it
when the workspace is created:

```bash
dim workspace create PROJECT WORKSPACE --backend BACKEND
```

The supported backends are:

| Backend | Outer runtime | Nested engine | Intended use |
| --- | --- | --- | --- |
| `sysbox` | `sysbox-runc` | Docker | Production default for Docker-compatible nested workloads |
| `gvisor` | `runsc` | Docker | No-KVM sandboxed fallback |
| `rootless-podman` | `runc` | Podman | Lower-privilege Podman-compatible workloads |
| `runc` | privileged `runc` | Docker | Nested development containers and CI only |

The backend is immutable for the lifetime of a workspace. Create a new
workspace to change it. `workspace show` reports the persisted selection.

`rootless-podman` requires `/dev/fuse` and a host that permits nested
unprivileged user namespaces. `doctor --backend rootless-podman` checks the
device and image, but creation is the definitive host compatibility test.

`DIM_WORKSPACE_BACKEND` changes the default used when `--backend` is omitted.
`DIM_WORKSPACE_IMAGE`, `DIM_WORKSPACE_RUNTIME`, and
`DIM_WORKSPACE_PRIVILEGED` are advanced image/runtime overrides; they do not
change the backend stored in workspace metadata.

CPU, memory, and PID limits apply to the top-level workspace container and
therefore bound its nested workloads in aggregate. DIM does not impose a
per-workspace disk quota. `workspace discard --yes` removes the workspace
container and its nested-engine storage volume.

Projects using `.dim/setup.sh` can inspect `DIM_WORKSPACE_BACKEND` and
`DIM_NESTED_ENGINE`. The default `.dim/docker-compose.yml` setup uses
`docker compose` for Docker backends and `podman compose` for
`rootless-podman`.
