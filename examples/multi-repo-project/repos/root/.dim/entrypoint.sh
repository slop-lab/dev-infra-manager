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
  hello)
    echo "hello from the example project"
    ;;
  codex)
    compose_exec dev codex --dangerously-bypass-approvals-and-sandbox "$@"
    ;;
  claude)
    compose_exec dev claude --dangerously-skip-permissions "$@"
    ;;
  secret)
    action="${1:?secret action is required (start, stop, restart, or status)}"
    case "$action" in
      start|stop|restart)
        compose_exec dev wget -qO- --post-data="" \
          "http://secret-control:7100/$action"
        ;;
      status)
        compose_exec dev wget -qO- "http://secret-control:7100/status"
        ;;
      *)
        echo "unknown secret action: $action" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "unknown task: $task" >&2
    exit 2
    ;;
esac
