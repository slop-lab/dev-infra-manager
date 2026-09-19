#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift
case "$task" in
  backup|restore)
    test "$#" -eq 0 || { echo "$task does not accept arguments" >&2; exit 2; }
    exec sh .dim/home-archive.sh "$task"
    ;;
  bash) set -- bash "$@" ;;
  ssh-proxy)
    test "$#" -eq 0 || { echo "ssh-proxy does not accept arguments" >&2; exit 2; }
    exec docker compose \
      --file .dim/docker-compose.yml exec --no-TTY agent nc 127.0.0.1 22
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

if [ -t 0 ] && [ -t 1 ]; then
  exec docker compose \
    --file .dim/docker-compose.yml exec \
    --user "$(id -u):$(id -g)" --env HOME=/home/dim-agent agent "$@"
else
  exec docker compose \
    --file .dim/docker-compose.yml exec --no-TTY \
    --user "$(id -u):$(id -g)" --env HOME=/home/dim-agent agent "$@"
fi
