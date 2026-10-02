set shell := ["bash", "-uc"]

mod runner 'just/runner.just'
mod verify 'verification/verify.just'

default:
    just --list --list-submodules

# Install the locked monorepo dependencies without changing the lockfile.
install-dependencies:
    pnpm install --frozen-lockfile

# Type-check all workspace packages without emitting build output.
typecheck:
    pnpm run workspace:check

# Run all workspace unit and integration tests that require only Node.js and pnpm.
test:
    pnpm run workspace:test

# Build all publishable workspace packages.
build-packages:
    pnpm run workspace:build

# Run the complete source gate; requires only Node.js and pnpm.
check-source:
    bash verification/scripts/repository-materialization-smoke.bash
    just typecheck
    just test
    just build-packages

# Prepare matched package and image candidates from one reviewed monorepo commit.
prepare-local:
    bash scripts/prepare-source-build.bash

# Install the prepared local DIM package set without changing the managed controller.
install-local:
    bash scripts/install-source-build.bash

# Restart the managed controller with the currently installed DIM package set.
restart-controller:
    if command -v mise >/dev/null 2>&1; then mise exec -- dim controller restart; else "${DIM_INSTALL_PREFIX:-$HOME/.local}/bin/dim" controller restart; fi

# Install local DIM packages before restarting the managed control plane.
install-local-control-plane: install-local

# Builds image dependencies and core first, then runs the local dim CLI from source (no install needed).
run-cli *args:
    pnpm --filter @slop-lab/dim-controller-proxy run build
    pnpm --filter @slop-lab/dim-core run build
    pnpm --dir core-development exec tsx ../core/packages/cli/src/cli.ts {{ args }}

# Check that the local CLI source can be executed without installing it.
check-run-cli:
    just run-cli -- --help >/dev/null

# Diagnose host readiness with the local CLI source.
doctor:
    just run-cli doctor

# Build the Docker-compatible Project workspace runtime image.
build-workspace-image:
    just run-cli workspace image build

# Build the Docker-compatible Project workspace runtime image for local sources.
build-local-workspace-image:
    image_version="$(bash verification/scripts/local-build-version.bash)"; DIM_LOCAL_BUILD_VERSION="$image_version" just run-cli workspace image build
