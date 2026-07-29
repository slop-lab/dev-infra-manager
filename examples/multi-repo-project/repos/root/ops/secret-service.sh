#!/usr/bin/env sh
set -eu

task="${1:?secret service task is required}"
shift

case "$task" in
  deploy-secret)
    : "${EXAMPLE_SECRET:?EXAMPLE_SECRET is required}"
    checkout=/tmp/dim-controller/secrets
    mkdir -p "$(dirname "$checkout")"
    rm -rf "$checkout"
    git clone --branch main --single-branch \
      "$DIM_GIT_BASE_URL/secrets.git" "$checkout"
    EXAMPLE_SECRET="$EXAMPLE_SECRET" SECRET_SERVICE_CONTEXT="$checkout" \
      docker compose --file .dim/docker-compose.yml --profile secret \
      up --detach --build secret
    ;;
  secret-health)
    docker compose --file .dim/docker-compose.yml exec -T secret \
      wget -qO- http://127.0.0.1:7099/healthz
    ;;
  remove-secret)
    docker compose --file .dim/docker-compose.yml rm --stop --force secret
    ;;
  *)
    echo "unknown secret service task: $task" >&2
    exit 2
    ;;
esac
