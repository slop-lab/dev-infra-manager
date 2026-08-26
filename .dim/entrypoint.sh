#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift
case "$task" in
  backup|restore)
    test "$#" -eq 0 || { echo "$task does not accept arguments" >&2; exit 2; }
    exec sh .dim/home-archive.sh "$task"
    ;;
  bash)
    set -- bash "$@"
    ;;
  codex)
    set -- codex --dangerously-bypass-approvals-and-sandbox "$@"
    ;;
  verify-qemu)
    set -- node /workspace/project/.dim/qemu-client.mjs run "$@"
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

if [ -t 0 ] && [ -t 1 ]; then
  exec docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
    --file .dim/docker-compose.yml \
    --file /tmp/dim-project-compose-host-aliases.json exec \
    --user root agent-dind dim-agent-dind exec "$@"
else
  exec docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
    --file .dim/docker-compose.yml \
    --file /tmp/dim-project-compose-host-aliases.json exec --no-TTY \
    --user root agent-dind dim-agent-dind exec "$@"
fi
