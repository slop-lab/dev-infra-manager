#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift
case "$task" in
  backup|restore)
    test "$#" -eq 0 || { echo "$task does not accept arguments" >&2; exit 2; }
    exec sh .dim/home-archive.sh "$task"
    ;;
  package-local)
    test "$#" -eq 0 || { echo "package-local does not accept arguments" >&2; exit 2; }
    set -- sh /workspace/project/.dim/package-local.sh
    ;;
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
  --user root private-docker dim-private-agent exec "$@"
