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
    docker compose --file .dim/docker-compose.yml --profile secure \
      up --detach --build --wait secure-dind
    tar --exclude=.git -C "$checkout" -cf - . | docker compose \
      --file .dim/docker-compose.yml exec --no-TTY \
      --env "EXAMPLE_SECRET=$EXAMPLE_SECRET" secure-dind dim-secure-dind deploy
    ;;
  secret-health)
    docker compose --file .dim/docker-compose.yml exec --no-TTY \
      secure-dind dim-secure-dind health
    ;;
  remove-secret)
    docker compose --file .dim/docker-compose.yml exec --no-TTY \
      secure-dind dim-secure-dind remove
    ;;
  *)
    echo "unknown secret service task: $task" >&2
    exit 2
    ;;
esac
