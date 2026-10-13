#!/usr/bin/env bash
set -euo pipefail

cd /workspace
export npm_config_workspace_concurrency=1
test "$(/usr/bin/git --version)" = "git version 2.43.0"
[[ "$(node --version)" =~ ^v(24|26)\. ]]
test "$(python3 --version)" = "Python 3.13.7"
test "$(pnpm --version)" = "10.13.1"
test ! -e .gitcredentials
test ! -e .local

if (( $# == 0 )); then
  exec just check-source-native
fi
exec "$@"
