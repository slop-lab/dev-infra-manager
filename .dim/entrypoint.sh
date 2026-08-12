#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  bash)
    set -- bash "$@"
    ;;
  codex)
    # Keep ad-hoc DIM tasks in the agent service's default cgroup so they stay
    # responsive when Codex and the commands it starts are busy.
    set -- dim-tool-cgroup tools-0 codex --dangerously-bypass-approvals-and-sandbox "$@"
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
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json exec \
  --user "$(id -u):$(id -g)" --env HOME=/tmp/dim-agent-home agent "$@"
