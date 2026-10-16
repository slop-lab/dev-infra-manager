#!/usr/bin/env bash
set -euo pipefail

cd /workspace
export npm_config_workspace_concurrency=1
test "$(/usr/bin/git --version)" = "git version 2.43.0"
case "${DIM_SOURCE_NODE_MAJOR:-24}" in
  24) test "$(node --version)" = "v24.19.0" ;;
  26) test "$(node --version)" = "v26.5.0" ;;
  *) printf 'unsupported source-gate Node.js lane\n' >&2; exit 2 ;;
esac
printf 'source-gate runtime: %s\n' "$(node --version)"
test "$(python3 --version)" = "Python 3.13.7"
test "$(pnpm --version)" = "10.13.1"
test ! -e .gitcredentials
test ! -e .local

if (( $# == 0 )); then
  exec just check-source-native
fi
exec "$@"
