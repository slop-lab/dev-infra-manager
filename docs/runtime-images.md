# Workspace Runtime Images

The Docker-compatible project workspace image is built from
[`images/project-workspace`](../images/project-workspace):

```bash
just build-project-workspace
```

It contains Node.js, pnpm, Codex, Git, and a nested Docker daemon. Sysbox,
gVisor, and privileged-runc workspaces use this image.

The rootless Podman image is built from
[`images/project-workspace-podman`](../images/project-workspace-podman):

```bash
just build-project-podman-image
```

It contains the same project tooling with Podman and podman-compose. Its
container storage is persisted in the workspace runtime volume at
`/home/agent/.local/share/containers`.

Neither image receives the host Docker socket or a host checkout. Project
source is cloned inside the top-level workspace container.
