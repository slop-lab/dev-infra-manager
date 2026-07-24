# Workspace Image Entrypoints

## Docker-compatible image

`images/project-workspace` starts a private Docker daemon, waits for readiness,
sets ownership on the workspace and nested-engine storage, and executes the
requested command as `agent`.

`DIM_DOCKERD_FLAGS` may add backend-specific daemon flags. The image must not
mount or contact the host Docker socket.

Before starting `dockerd`, the entrypoint removes managed containerd runtime
state below `/var/run/docker/containerd`. That state belongs to the previous
PID namespace and must not survive stop/start of the same workspace container.

## Rootless Podman image

`images/project-workspace-podman` prepares the agent home, Codex home,
`XDG_RUNTIME_DIR`, and rootless Podman storage before executing the requested
command as `agent`.

Both images include the DIM Git askpass helper and project development tools.
