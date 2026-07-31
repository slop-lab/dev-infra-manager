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
  check)
    set -- pnpm run workspace:check "$@"
    ;;
  test)
    set -- pnpm run workspace:test "$@"
    ;;
  build)
    set -- pnpm run workspace:build "$@"
    ;;
  verify)
    set -- just check "$@"
    ;;
  verify-container-runc)
    set -- just verify-container-runc "$@"
    ;;
  verify-container-sysbox)
    set -- just verify-container-sysbox "$@"
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

exec docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml exec \
  --user "$(id -u):$(id -g)" --env HOME=/tmp/dim-agent-home agent "$@"
