set shell := ["bash", "-uc"]

default:
    just --list

install:
    pnpm install --frozen-lockfile

install-host-ubuntu:
    JUST_BIN="{{ just_executable() }}" bash scripts/install-host-ubuntu.sh

install-runsc-linux:
    bash scripts/install-runsc-linux.sh

bootstrap-ubuntu:
    JUST_BIN="{{ just_executable() }}" bash scripts/bootstrap-ubuntu.sh

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

workspace-verify:
    pnpm run workspace:check
    pnpm run workspace:test
    pnpm run workspace:build

# Verification that is safe to run from the nested development container.
# It deliberately avoids Sysbox, KVM, loop devices, systemd, and sudo.
container-verify:
    pnpm run workspace:check
    pnpm run workspace:test
    pnpm run workspace:build
    bash scripts/plugin-install-smoke.sh
    pnpm run cli -- config validate --config config.example.json
    bash scripts/container-cgroup-smoke.sh

# Heavier nested-Docker smoke checks available without Sysbox in this container.
container-runtime-verify:
    just container-verify
    just build-project-workspace
    docker build --force-rm -t dev-infra-agent-workspace:latest images/agent-workspace
    bash scripts/container-inner-docker-smoke.sh
    bash scripts/container-lifecycle-smoke.sh
    bash scripts/container-packed-project-smoke.sh
    bash scripts/container-self-project-smoke.sh

# Build and link the dim CLI for use from other local projects.
install-dim-local:
    bash scripts/install-dim-local.sh

isolation-check:
    pnpm --filter @slop-lab/dev-infra-manager-core exec vitest run test/docker.test.ts

isolation-check-json:
    pnpm --filter @slop-lab/dev-infra-manager-core exec vitest run test/docker.test.ts --reporter=json

doctor:
    pnpm run cli -- doctor

sample-config:
    pnpm run cli -- init-config --output dev-infra.config.json

build-agent-image:
    docker build -t dev-infra-agent-workspace:latest images/agent-workspace

build-project-workspace:
    docker build --force-rm --build-arg "AGENT_UID=$(id -u)" --build-arg "AGENT_GID=$(id -g)" -t dev-infra-project-workspace:latest images/project-workspace

build-agent-podman-image:
    docker build -t dev-infra-agent-workspace-podman:latest images/agent-workspace-podman

build-secret-example:
    docker build -t dev-infra-secret-runtime:latest images/secret-runtime-example

smoke *args:
    @bash scripts/smoke.sh {{args}}
