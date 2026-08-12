set shell := ["bash", "-uc"]

default:
    just --list

install:
    pnpm install --frozen-lockfile

# Builds the pinned Sysbox + nested-KVM GitHub Actions QEMU base image.
build-github-runner-kvm:
    bash images/github-actions-runner-kvm/build.bash

# Boots the base image without registering it and exercises Sysbox + nested KVM.
verify-github-runner-kvm:
    bash images/github-actions-runner-kvm/run.bash --check

# Runs one ephemeral self-hosted Actions job, then deletes the VM overlay.
run-github-runner-kvm:
    bash images/github-actions-runner-kvm/run.bash

# Requires QEMU and writable /dev/kvm; uses one clean VM per supported backend.
verify-environments-kvm verbose="":
    bash scripts/kvm-host-install-smoke.bash all "{{verbose}}"

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

# Build packages and verify plugin installation through the published package shape.
verify-plugin-install:
    just build
    bash scripts/plugin-install-smoke.bash

# Verify every publishable package through the same dry-run used before release.
verify-package-packs:
    pnpm --filter @slop-lab/dim-core run pack:dry-run
    pnpm --filter @slop-lab/dim-contracts-external-url run pack:dry-run
    pnpm --filter @slop-lab/dim-controller-proxy run pack:dry-run
    pnpm --filter @slop-lab/dim-plugin-external-urls run pack:dry-run
    pnpm --filter @slop-lab/dim-plugin-dns-cloudflare run pack:dry-run
    pnpm --filter @slop-lab/dim-cli run pack:dry-run
    pnpm --filter @slop-lab/dim-installer run pack:dry-run

# GitHub Actions' Node-only lane, after dependencies have been installed.
ci-check:
    just check
    just verify-plugin-install
    pnpm audit --prod
    just verify-package-packs

# GitHub Actions' Docker lane, after dependencies have been installed.
ci-container:
    just check
    just verify-container
    bash scripts/container-cgroup-smoke.bash

# Manually dispatched Sysbox Actions lane, after dependencies have been installed.
ci-sysbox:
    just check
    just verify-container
    bash scripts/container-sysbox-isolation-smoke.bash

# Manually dispatched KVM backend-installer Actions lane.
ci-kvm:
    test -r /dev/kvm -a -w /dev/kvm
    just verify-environments-kvm

# Run the complete CI gate once with the active Node.js version.
ci:
    just install
    just ci-check
    just verify-container
    bash scripts/container-cgroup-smoke.bash

# Reproduce GitHub Actions locally; pass --manual to include dispatched workflows.
ci-matrix *args:
    bash scripts/local-ci-matrix.bash {{args}}

# Backend-independent container integration; may run against nested Docker in a development container.
verify-container:
    docker info >/dev/null
    docker compose version >/dev/null
    just build-project-workspace
    bash scripts/container-inner-docker-smoke.bash
    bash scripts/container-lifecycle-smoke.bash
    bash scripts/container-packed-project-smoke.bash
    bash scripts/container-self-project-smoke.bash

# Build and link the dim CLI for use from other local projects.
install-dim-local:
    bash scripts/install-dim-local.bash

# Requires Docker and network access; exercises `mise use --raw --global npm:@slop-lab/dim-installer` in a disposable container.
verify-mise-install-smoke:
    bash scripts/mise-install-smoke.bash

# Verify examples on the current host or in a separate disposable backend VM per example.
verify-example backend="current-installed" dirty_repo="auto" example="all":
    bash scripts/verify-example.bash --backend "{{backend}}" --dirty-repo "{{dirty_repo}}" --example "{{example}}"

# Verify this repository's .dim contract with Docker and managed Gitea.
verify-self-development:
    docker info >/dev/null
    docker compose version >/dev/null
    just build
    just build-project-workspace
    bash scripts/container-self-project-smoke.bash

isolation-check:
    pnpm --filter @slop-lab/dim-core exec vitest run test/lifecycle.test.ts

isolation-check-json:
    pnpm --filter @slop-lab/dim-core exec vitest run test/lifecycle.test.ts --reporter=json

# Builds core first, then runs the local dim CLI from source (no install needed).
cli *args:
    pnpm --filter @slop-lab/dim-core run build
    pnpm --filter @slop-lab/dim-cli exec tsx src/cli.ts {{args}}

doctor:
    just cli doctor

build-project-workspace:
    pnpm --filter @slop-lab/dim-controller-proxy run build
    docker build --quiet --force-rm --build-arg "DIM_UID=$(id -u)" --build-arg "DIM_GID=$(id -g)" -t dev-infra-project-workspace:latest -f images/project-workspace/Dockerfile . >/dev/null
