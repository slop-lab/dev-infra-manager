#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  bash)
    set -- bash "$@"
    ;;
  codex)
    set -- codex --dangerously-bypass-approvals-and-sandbox "$@"
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

exec docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json exec \
  --user "$(id -u):$(id -g)" \
  --env HOME=/home/dim-agent agent "$@"
