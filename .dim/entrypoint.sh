#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

case "$task" in
  codex)
    exec codex --dangerously-bypass-approvals-and-sandbox "$@"
    ;;
  check)
    exec pnpm run workspace:check "$@"
    ;;
  test)
    exec pnpm run workspace:test "$@"
    ;;
  build)
    exec pnpm run workspace:build "$@"
    ;;
  verify)
    pnpm run workspace:check
    pnpm run workspace:test
    exec pnpm run workspace:build "$@"
    ;;
  container-verify)
    exec just container-verify "$@"
    ;;
  container-runtime-verify)
    exec just container-runtime-verify "$@"
    ;;
  *)
    echo "unknown DIM project task: $task" >&2
    exit 2
    ;;
esac

