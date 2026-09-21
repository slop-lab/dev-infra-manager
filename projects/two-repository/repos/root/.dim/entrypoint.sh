#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  app)
    test "$#" -gt 0 || {
      echo "app requires a command" >&2
      exit 2
    }
    exec docker compose --file .dim/docker-compose.yml exec --no-TTY \
      --user "$(id -u):$(id -g)" --workdir /workspace \
      --env HOME=/home/dim-agent app "$@"
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac
