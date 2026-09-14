# Workspace Runtime Image

The project workspace image is built from
[`core/images/project-workspace`](../../core/images/project-workspace):

```bash
just build-workspace-image
```

Check whether the configured image exists locally without building it:

```bash
dim workspace image status
dim workspace image status --json
```

The command inspects `DIM_WORKSPACE_IMAGE` or the default image and reports
`ready` with its image ID, or `missing`. Other inspection failures are errors.
Image status is independent of host readiness and workspace lifecycle state.
Restarting the controller does not build the image or mark it ready; Project
and development scripts own image builds.

The build packages `@slop-lab/dim-controller-proxy` and includes its restricted
controller-socket helper. The image contains Node.js, pnpm, Codex, Git, and a
nested Docker daemon. It receives neither the host Docker socket nor a host
checkout; Project source is cloned inside the trusted workspace container.

Project-owned agent examples use the reviewed official
`docker:29.1.3-dind-rootless` image inside the Sysbox boundary. The canonical
top-level agent image creates a non-root `dim-agent` account with a configurable
nonzero UID. Its optional SSH service accepts key authentication only for that
account and disables root login.

## GitHub Actions QEMU runner

[`images/github-actions-runner-kvm`](../../images/github-actions-runner-kvm)
builds a reviewed Ubuntu qcow2 base image with Sysbox, QEMU, and nested KVM.
`just runner run` starts an ephemeral overlay, registers one `sysbox,kvm`
self-hosted runner job, and discards the overlay afterward.
