#!/usr/bin/env bash
set -euo pipefail

export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/dim-docker-config}"
mkdir -p "$DOCKER_CONFIG"

docker compose -f .dim/docker-compose.yml exec -T dev \
  bash /usr/local/bin/request-urls.bash
