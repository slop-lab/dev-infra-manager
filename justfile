set shell := ["bash", "-uc"]

mod ci 'just/ci.just'
mod runner 'just/runner.just'
mod verify 'just/verify.just'

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
    just typecheck
    just test
    just build-packages

# Build and install the local dim CLI package set for use from other projects.
install-local-cli:
    bash scripts/install-dim-local.bash

# Builds core first, then runs the local dim CLI from source (no install needed).
run-cli *args:
    pnpm --filter @slop-lab/dim-core run build
    pnpm --filter @slop-lab/dim-cli exec tsx src/cli.ts {{ args }}

# Diagnose host readiness with the local CLI source.
doctor:
    just run-cli doctor

# Build the Docker-compatible Project workspace runtime image.
build-workspace-image:
    pnpm --filter @slop-lab/dim-controller-proxy run build
    docker build --quiet --force-rm --build-arg "DIM_UID=$(id -u)" --build-arg "DIM_GID=$(id -g)" -t dev-infra-project-workspace:latest -f images/project-workspace/Dockerfile . >/dev/null
