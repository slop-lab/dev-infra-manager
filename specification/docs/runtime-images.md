# Workspace images

The base package ships its own small image context. It has no controller-proxy,
CI or managed Git runtime dependency. Build on the selected host:

```bash
dim image build
```

The default tag is `dev-infra-project-workspace:<installed package version>`.
`--image` or `DIM_WORKSPACE_IMAGE` selects an explicitly tagged build destination;
image IDs, digest destinations, untagged names and `latest` are rejected before
building. Docker Buildx loads the result locally. `dim doctor` checks whether
the selected workspace image is available. Lifecycle does not build an image
implicitly.

The image contains common development tools, a non-root `dim` user, an init
process and its private Docker daemon. Nested images and volumes persist under
`/var/lib/docker`; the daemon disables the separate containerd image store so
these bytes share the workspace's owned Docker-data volume. The agent receives
neither the host Docker socket nor a host checkout bind. Repository tools and
coding-agent configuration remain explicit user state.

For a matched source package/image set:

```bash
just prepare-local
just install-local
```

Preparation archives a source identity and aggregate lockfile, builds matching
artifacts and publishes readiness only after staging succeeds. Installation
validates that preparation rather than rebuilding the image. Base and managed
images use different names and contexts.

The optional managed runtime includes the trusted Project lifecycle and
controller-proxy assets. Its default tag is
`dev-infra-managed-workspace:<installed package version>` and its explicit
override is `DIM_MANAGED_WORKSPACE_IMAGE`. Build it through
`dim managed workspace image build` after configuring the managed integration.
Do not substitute the base image for a managed lifecycle image.
