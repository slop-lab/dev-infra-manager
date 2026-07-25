#!/usr/bin/env sh
set -eu
task="${1:?task is required}"
shift
case "$task" in
  hello) echo "hello from the example project" ;;
  *) echo "unknown task: $task" >&2; exit 2 ;;
esac
