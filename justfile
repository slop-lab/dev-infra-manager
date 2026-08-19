set shell := ["bash", "-uc"]

mod ci 'just/ci.just'
mod runner 'just/runner.just'
mod verify 'just/verify.just'

default:
    just --list --list-submodules

install:
    pnpm install --frozen-lockfile

# Type-check all workspace packages without emitting build output.
typecheck:
    pnpm run workspace:check

# Run all workspace unit and integration tests that require only Node.js and pnpm.
test:
    pnpm run workspace:test

# Build all publishable workspace packages.
build:
    pnpm run workspace:build

# Run the complete source gate; requires only Node.js and pnpm.
check:
    just typecheck
    just test
    just build

# Build and link the dim CLI for use from other local projects.
install-dim-local:
    bash scripts/install-dim-local.bash

# Builds core first, then runs the local dim CLI from source (no install needed).
cli *args:
    pnpm --filter @slop-lab/dim-core run build
    pnpm --filter @slop-lab/dim-cli exec tsx src/cli.ts {{ args }}

doctor:
    just cli doctor

build-project-workspace:
    pnpm --filter @slop-lab/dim-controller-proxy run build
    docker build --quiet --force-rm --build-arg "DIM_UID=$(id -u)" --build-arg "DIM_GID=$(id -g)" -t dev-infra-project-workspace:latest -f images/project-workspace/Dockerfile . >/dev/null
