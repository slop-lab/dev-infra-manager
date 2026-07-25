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
`/home/dim/.local/share/containers`.

Neither image receives the host Docker socket or a host checkout. Project
source is cloned inside the top-level workspace container.

## GitHub Actions QEMU runner

[`images/github-actions-runner-kvm`](../images/github-actions-runner-kvm)
builds a reviewed Ubuntu qcow2 base image with Sysbox, QEMU, and nested KVM.
`just run-github-runner-kvm` starts an ephemeral overlay, registers one
`sysbox,kvm` self-hosted runner job, and discards the overlay afterward. Runner
registration tokens are passed after boot and are never baked into the image.
