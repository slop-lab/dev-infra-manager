# Workspace Runtime Image

The project workspace image is built from
[`core/images/project-workspace`](../../core/images/project-workspace):

```bash
just build-workspace-image
```

The build packages `@slop-lab/dim-controller-proxy` and includes its restricted
controller-socket helper. The image contains Node.js, pnpm, Codex, Git, and a
nested Docker daemon. It receives neither the host Docker socket nor a host
checkout; Project source is cloned inside the trusted workspace container.

Project-owned agent examples use the reviewed official
`docker:29.1.3-dind-rootless` image inside the Sysbox boundary.

## GitHub Actions QEMU runner

[`images/github-actions-runner-kvm`](../../images/github-actions-runner-kvm)
builds a reviewed Ubuntu qcow2 base image with Sysbox, QEMU, and nested KVM.
`just runner run` starts an ephemeral overlay, registers one `sysbox,kvm`
self-hosted runner job, and discards the overlay afterward.
