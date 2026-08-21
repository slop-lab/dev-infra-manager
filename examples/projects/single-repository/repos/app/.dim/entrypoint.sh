#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift
no_tty=""

case "$task" in
  backup|restore)
    test "$#" -eq 0 || { echo "$task does not accept arguments" >&2; exit 2; }
    set -- sh .dim/home-archive.sh "$task"
    no_tty="--no-TTY"
    ;;
  bash) set -- bash "$@" ;;
  codex) set -- codex --dangerously-bypass-approvals-and-sandbox "$@" ;;
  claude) set -- claude --dangerously-skip-permissions "$@" ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

exec docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml exec ${no_tty} \
  --user "$(id -u):$(id -g)" --env HOME=/tmp/dim-agent-home agent "$@"
