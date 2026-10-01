#!/usr/bin/env sh
set -eu

if [ "${DIM_WORKSPACE_DISCARD_KEEP_VOLUME:-}" = 1 ]; then
  docker compose \
    --file .dim/docker-compose.yml down --remove-orphans
else
  docker compose \
    --file .dim/docker-compose.yml down --volumes --remove-orphans
fi
