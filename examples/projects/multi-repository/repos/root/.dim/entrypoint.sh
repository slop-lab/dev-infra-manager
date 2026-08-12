#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  bash) set -- bash "$@" ;;
  codex) set -- codex --dangerously-bypass-approvals-and-sandbox "$@" ;;
  claude) set -- claude --dangerously-skip-permissions "$@" ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

exec docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml exec \
  --user "$(id -u):$(id -g)" --env HOME=/tmp/dim-agent-home agent "$@"
