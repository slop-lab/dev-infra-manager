set shell := ["bash", "-uc"]

default:
    just --list

install:
    pnpm install --frozen-lockfile

install-host-ubuntu:
    bash scripts/install-host-ubuntu.sh

bootstrap-ubuntu:
    bash scripts/bootstrap-ubuntu.sh

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

doctor:
    pnpm run cli -- doctor

sample-config:
    pnpm run cli -- init-config --output dev-infra.config.json

build-agent-image:
    sudo docker build -t dev-infra-agent-workspace:latest images/agent-workspace

build-secret-example:
    sudo docker build -t dev-infra-secret-runtime:latest images/secret-runtime-example

smoke:
    bash scripts/smoke.sh
