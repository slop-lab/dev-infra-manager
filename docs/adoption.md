# Adopting DIM Safely

DIM controls development containers and can affect environments that hold
secrets. The following requirements apply before another project adopts or
updates DIM.

## Required human review

A human reviewer must directly review all of the following at the exact
revision that will run:

1. The complete DIM repository, including controller, CLI, container,
   installation, and infrastructure code.
2. The complete project repository used by DIM, not only its `.dim` directory.
3. All code and configuration that builds, starts, deploys, or otherwise
   controls a secret-bearing container or environment. This includes
   Dockerfiles, Compose files, setup and entrypoint scripts, base images,
   dependencies, controller configuration, plugins, and deployment manifests.

Agent output, automated checks, and a review limited to the changed lines do
not replace this full human trust review. Repeat the review whenever any of
these inputs or their pinned versions change.

## Pin every version

Consumers must use immutable, exact versions. Do not track `latest`, a moving
branch, or an unbounded package range. Pin:

- DIM CLI, core, installer, and plugins to exact package versions.
- Source installations to a reviewed release tag or full commit SHA.
- Container base images and deployed images to reviewed immutable digests where
  practical.
- Project dependencies through the ecosystem lockfile.

For example:

```bash
npm install --global "@slop-lab/dim-cli@0.1.0"
npx "@slop-lab/install-dim@0.1.0" "@company/dim-plugin@1.2.3"
```

Treat the example versions as placeholders and select versions whose complete
source and artifacts were reviewed by your project.

## Repository branches

Ongoing development of this repository happens on `development`, not `main`.
Changes are promoted to `main` only after human review. Consumers must not run
directly from either moving branch; use a reviewed release tag, full commit
SHA, or exact published package version.
