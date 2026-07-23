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
    pnpm run check

test:
    pnpm run test

build:
    pnpm run build

verify:
    pnpm run check
    pnpm run test
    pnpm run build

isolation-check:
    pnpm exec vitest run test/docker.test.ts

isolation-check-json:
    pnpm exec vitest run test/docker.test.ts --reporter=json

doctor:
    pnpm run cli -- doctor

sample-config:
    pnpm run cli -- init-config --output dev-infra.config.json

build-agent-image:
    sudo docker build -t dev-infra-agent-workspace:latest images/agent-workspace

build-agent-podman-image:
    sudo docker build -t dev-infra-agent-workspace-podman:latest images/agent-workspace-podman

build-secret-example:
    sudo docker build -t dev-infra-secret-runtime:latest images/secret-runtime-example

smoke:
    bash scripts/smoke.sh
