set shell := ["bash", "-uc"]

default:
    just --list

install:
    pnpm install --frozen-lockfile

install-kvm-verify-deps-ubuntu:
    sudo apt-get update
    sudo apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils openssh-client
    test -r /dev/kvm -a -w /dev/kvm

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

# Requires Docker and network access; exercises `mise use -g npm:@slop-lab/install-dim` in a disposable container.
verify-mise-install-smoke:
    bash scripts/mise-install-smoke.bash

# Requires Docker and managed Gitea; materializes and verifies the multi-repository example.
verify-example-multi-repo-project:
    bash scripts/example-project-smoke.bash

# Materializes the external-URL repo and exercises root -> dev -> deep routing with dnsmasq.
verify-example-external-urls:
    bash scripts/external-url-example-smoke.bash

isolation-check:
    pnpm --filter @slop-lab/dev-infra-manager-core exec vitest run test/lifecycle.test.ts

isolation-check-json:
    pnpm --filter @slop-lab/dev-infra-manager-core exec vitest run test/lifecycle.test.ts --reporter=json

# Builds core first, then runs the local dim CLI from source (no install needed).
cli *args:
    pnpm --filter @slop-lab/dev-infra-manager-core run build
    pnpm --filter @slop-lab/dim-cli exec tsx src/cli.ts {{args}}

doctor:
    just cli doctor

build-project-workspace:
    docker build --force-rm --build-arg "DIM_UID=$(id -u)" --build-arg "DIM_GID=$(id -g)" -t dev-infra-project-workspace:latest images/project-workspace
