#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  app)
    test "$#" -gt 0 || {
      echo "app requires a command" >&2
      exit 2
    }
    cd "$DIM_PROJECT_ROOT/app"
    exec "$@"
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac
