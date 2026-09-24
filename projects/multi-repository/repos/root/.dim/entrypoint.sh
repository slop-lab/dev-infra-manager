#!/usr/bin/env sh
set -eu

DIM_PROJECT_TOOL_CONTRACT_VERSION=1
DIM_PROJECT_TOOL_LAUNCHER=agent
DIM_PROJECT_TOOL_NAME=opencode
DIM_PROJECT_TOOL_VERSION=1.18.31
DIM_PROJECT_TOOL_EXECUTABLE=/home/dim-agent/.local/bin/opencode
DIM_PROJECT_TOOL_RUNNER=/home/dim-agent/.local/libexec/dim-project-tool-launch

task="${1:?task is required}"
shift
case "$task" in
  backup|restore)
    test "$#" -eq 0 || { echo "$task does not accept arguments" >&2; exit 2; }
    exec sh .dim/home-archive.sh "$task"
    ;;
  bash) set -- bash "$@" ;;
  tool-setup)
    test "$#" -eq 0 || { echo "tool-setup does not accept arguments" >&2; exit 2; }
    set -- bash -s
    ;;
  agent)
    set -- "$DIM_PROJECT_TOOL_RUNNER" \
      "$DIM_PROJECT_TOOL_CONTRACT_VERSION" "$DIM_PROJECT_TOOL_LAUNCHER" \
      "$DIM_PROJECT_TOOL_NAME" "$DIM_PROJECT_TOOL_VERSION" \
      "$DIM_PROJECT_TOOL_EXECUTABLE" "$@"
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

if [ -t 0 ] && [ -t 1 ]; then
  exec docker compose \
    --file .dim/docker-compose.yml exec --interactive --tty \
    --user root agent-dind dim-agent-dind exec "$@"
fi
exec docker compose \
  --file .dim/docker-compose.yml exec --no-TTY \
  --user root agent-dind dim-agent-dind exec "$@"
