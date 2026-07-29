#!/usr/bin/env sh
set -eu
task="${1:?task is required}"
shift

# Use a real TTY when this task itself has one (an interactive agent
# session), and drop it for automated/non-interactive callers.
compose_exec() {
  if [ -t 0 ]; then
    docker compose --file .dim/docker-compose.yml exec "$@"
  else
    docker compose --file .dim/docker-compose.yml exec -T "$@"
  fi
}

case "$task" in
  bash)
    compose_exec dev bash "$@"
    ;;
  codex)
    compose_exec dev codex --dangerously-bypass-approvals-and-sandbox "$@"
    ;;
  claude)
    compose_exec dev claude --dangerously-skip-permissions "$@"
    ;;
  *)
    echo "unknown task: $task" >&2
    exit 2
    ;;
esac
