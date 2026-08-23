#!/usr/bin/env sh
set -eu

docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml down --remove-orphans
