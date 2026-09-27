#!/usr/bin/env sh
set -eu

export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/dim-docker-config}"
mkdir -p "$DOCKER_CONFIG"
docker compose -f .dim/docker-compose.yml "$@" up --detach --build --wait

existing="$(dim external-url list --json | jq -r 'first(.urls[] | select(.ingress == "tailnet-ssh") | .url) // empty')"
if [ -n "$existing" ]; then
  printf '%s\n' "$existing"
else
  dim external-url request --json \
    --ingress tailnet-ssh --container ssh --port 22 --protocol tcp
fi
