#!/usr/bin/env sh
set -eu

export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/dim-docker-config}"
mkdir -p "$DOCKER_CONFIG"

docker compose -f .dim/docker-compose.yml "$@" up --detach --build
