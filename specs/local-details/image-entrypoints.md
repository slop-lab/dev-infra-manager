# Workspace Image Entrypoints

## Docker-compatible image

`images/project-workspace` starts a private Docker daemon, waits for readiness,
sets ownership on the workspace and nested-engine storage, and executes the
requested command as the unprivileged `dim` user (`DIM_UID`/`DIM_GID` build
args select its UID/GID, both defaulting to 1000). This is the workspace-root
controller account, not the identity of an agent process; see [Trust
Boundaries](../02-boundaries-and-trust.md#controller-boundary).

`DIM_DOCKERD_FLAGS` may add backend-specific daemon flags. The image must not
mount or contact the host Docker socket.

Before starting `dockerd`, the entrypoint removes managed containerd runtime
state below `/var/run/docker/containerd`. That state belongs to the previous
PID namespace and must not survive stop/start of the same workspace container.

## Rootless Podman image

`images/project-workspace-podman` prepares `dim`'s home, Codex home,
`XDG_RUNTIME_DIR`, and rootless Podman storage before executing the requested
command as `dim`, the same unprivileged user as the Docker-compatible image.

Both images include the DIM Git askpass helper and project development tools.
