#!/usr/bin/env sh
set -eu

docker compose \
  --file .dim/docker-compose.yml down --remove-orphans
