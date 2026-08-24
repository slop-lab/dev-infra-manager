#!/usr/bin/env sh
set -eu

docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json \
  down --volumes --remove-orphans
