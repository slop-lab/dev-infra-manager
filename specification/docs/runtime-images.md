# Workspace Runtime Image

The published CLI ships the complete trusted workspace-image context and an
exact-version dependency on the published controller proxy. A released
installation builds its matching image from any directory without a source
checkout, `just`, or pnpm:

```bash
dim workspace image build
dim workspace image status
```

The command uses Docker Buildx with `--load`, passes the invoking user's UID and
GID, and tags `dev-infra-project-workspace:<installed DIM package version>`.
`DIM_WORKSPACE_IMAGE` may select another explicitly tagged destination. Image
IDs, digest references, untagged references, and `latest` are rejected before
Docker runs.

Prepare the matched package and image candidate before installing it:

```bash
just prepare-local
just install-local
```

The local package tarballs and image use exactly one aggregate local version.
Its identity covers one exact root monorepo commit and the SHA-256 digest of
the reviewed aggregate dependency lock from that commit. The temporary
production workspace is archived from that commit and installs dependencies
with the frozen lock. A missing or stale lock stops preparation before package
or image publication without changing tracked source. The root repository's
`just prepare-local` workflow prepares the same matched package and image set
before `just install-local`.

Check whether the configured image exists locally without building it:

```bash
dim workspace image status
dim workspace image status --json
```

The command inspects `DIM_WORKSPACE_IMAGE` or
`dev-infra-project-workspace:<installed DIM package version>` and reports
`ready` with its image ID, or `missing`. Other inspection failures are errors.
Release packages select their release tag. Local package bundles select the
tag for their shared aggregate local version; there is no implicit `latest`
fallback.
Image build and status are independent of host and controller readiness and
workspace lifecycle state. Restarting the controller does not build the image
or mark it ready, and no workspace lifecycle operation builds it implicitly.

The build stages the complete exact-version published
`@slop-lab/dim-controller-proxy` dependency and includes its restricted
controller-socket helper. The image contains the trusted Project lifecycle
toolchain and a nested Docker daemon. It does not install a coding-agent CLI.
It receives neither the host Docker socket nor a host checkout; Project source
is cloned inside the trusted workspace container.

Project-owned agent examples use the reviewed official
`docker:29.1.3-dind-rootless` image inside the Sysbox boundary. The canonical
top-level agent image creates a non-root `dim-agent` account with a configurable
nonzero UID. Its optional SSH service accepts key authentication only for that
account and disables root login.
Their base images may provide common development dependencies, but coding-agent
tools and user configuration are explicit workspace-user state. A Project may
offer a pinned bootstrap whose canonical mutation targets, including its XDG
configuration directory and symbolic-link destinations, remain below the
persistent agent home. Trusted `.dim/setup.sh`, workspace image construction,
and DIM lifecycle commands must not run that bootstrap automatically.
The same boundary applies to an optional authenticated OpenCode Web launcher:
the image and lifecycle may provide a narrowly scoped external-URL proxy path,
but only an explicit workspace-user command starts the listener.

## GitHub Actions QEMU runner

[`images/github-actions-runner-kvm`](../../images/github-actions-runner-kvm)
builds a reviewed Ubuntu qcow2 base image with Sysbox, QEMU, and nested KVM.
`just runner run` starts an ephemeral overlay, registers one `sysbox,kvm`
self-hosted runner job, and discards the overlay afterward.
