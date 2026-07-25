#!/usr/bin/env sh
set -eu

task="${1:?controller task is required}"
shift

case "$task" in
  deploy-secret)
    : "${EXAMPLE_SECRET:?EXAMPLE_SECRET is required}"
    checkout=/tmp/dim-controller/secrets
    mkdir -p "$(dirname "$checkout")"
    rm -rf "$checkout"
    git clone "$DIM_GIT_BASE_URL/secrets.git" "$checkout"
    docker build --tag example-secret-service "$checkout"
    docker rm --force example-secret-service >/dev/null 2>&1 || true
    docker run --detach --name example-secret-service \
      --env EXAMPLE_SECRET \
      example-secret-service
    ;;
  secret-health)
    docker exec example-secret-service \
      wget -qO- http://127.0.0.1:7099/healthz
    ;;
  remove-secret)
    docker rm --force example-secret-service
    ;;
  *)
    echo "unknown controller task: $task" >&2
    exit 2
    ;;
esac
