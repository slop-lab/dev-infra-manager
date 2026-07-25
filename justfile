set shell := ["bash", "-uc"]

default:
    just --list

install:
    pnpm install --frozen-lockfile

install-host-backend-ubuntu backend:
    bash scripts/install-host-ubuntu.sh "{{backend}}"
    just verify-host-backend-local "{{backend}}"

install-host-sysbox-ubuntu:
    just install-host-backend-ubuntu sysbox

install-host-gvisor-ubuntu:
    just install-host-backend-ubuntu gvisor

install-host-rootless-podman-ubuntu:
    just install-host-backend-ubuntu rootless-podman

install-host-runc-ubuntu:
    just install-host-backend-ubuntu runc

# Requires the selected backend to be installed on the current host; readiness check only.
verify-host-backend-local backend:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "{{backend}}" == rootless-podman ]]; then just build-project-podman-image; fi
    just cli doctor --backend "{{backend}}"

install-kvm-verify-deps-ubuntu:
    sudo apt-get update
    sudo apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils openssh-client
    test -r /dev/kvm -a -w /dev/kvm

# Builds the pinned Sysbox + nested-KVM GitHub Actions QEMU base image.
build-github-runner-kvm:
    bash images/github-actions-runner-kvm/build.sh

# Boots the base image without registering it and exercises Sysbox + nested KVM.
verify-github-runner-kvm:
    bash images/github-actions-runner-kvm/run.sh --check

# Runs one ephemeral self-hosted Actions job, then deletes the VM overlay.
run-github-runner-kvm:
    bash images/github-actions-runner-kvm/run.sh

install-runsc-linux:
    bash scripts/install-runsc-linux.sh

# Requires QEMU and writable /dev/kvm; installs and exercises one backend in a disposable VM.
verify-host-backend-kvm backend verbose="":
    bash scripts/kvm-host-install-smoke.sh "{{backend}}" "{{verbose}}"

# Requires QEMU and writable /dev/kvm; uses one clean VM per supported backend.
verify-host-backends-kvm verbose="":
    bash scripts/kvm-host-install-smoke.sh all "{{verbose}}"

bootstrap-ubuntu backend="sysbox":
    JUST_BIN="{{ just_executable() }}" bash scripts/bootstrap-ubuntu.sh "{{backend}}"

check:
    pnpm run workspace:check

test:
    pnpm run workspace:test

build:
    pnpm run workspace:build

verify:
    pnpm run workspace:check
    pnpm run workspace:test
    pnpm run workspace:build

# Shared prerequisites for the runc nested-container verification.
_verify-container-runc-base:
    just verify
    bash scripts/plugin-install-smoke.sh
    bash scripts/container-cgroup-smoke.sh

# Requires Docker, Compose v2, and privileged runc containers; does not require Sysbox or KVM.
verify-container-runc:
    docker info >/dev/null
    docker compose version >/dev/null
    just _verify-container-runc-base
    just build-project-workspace
    bash scripts/container-inner-docker-smoke.sh
    DIM_WORKSPACE_BACKEND=runc bash scripts/container-lifecycle-smoke.sh
    DIM_WORKSPACE_BACKEND=runc bash scripts/container-packed-project-smoke.sh
    DIM_WORKSPACE_BACKEND=runc bash scripts/container-self-project-smoke.sh

# Build and link the dim CLI for use from other local projects.
install-dim-local:
    bash scripts/install-dim-local.sh

# Requires Docker and network access; exercises `mise use -g npm:@slop-lab/install-dim` in a disposable container.
verify-mise-install-smoke:
    bash scripts/mise-install-smoke.sh

# Requires Docker; proves examples/external-urls/README.md with dnsmasq and real nested containers.
verify-example-project:
    bash scripts/external-url-example-smoke.sh

# Exercises root -> dev -> deep routing through host proxy and dnsmasq wildcard DNS.
verify-external-url-example:
    bash scripts/external-url-example-smoke.sh

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

build-project-podman-image:
    docker build -t dev-infra-project-workspace-podman:latest images/project-workspace-podman

# Requires a Docker host with the sysbox-runc runtime registered and usable.
verify-container-sysbox *args:
    @bash scripts/smoke.sh {{args}}
