#!/usr/bin/env bash
set -euo pipefail

# Tools belong to this disposable job, not the host or a Project runner image.
export PATH="$HOME/.local/dim-ci-tools/bin:$PATH"
if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != 10.13.1 ]]; then
  npm install --global --prefix "$HOME/.local/dim-ci-tools" --ignore-scripts --no-audit --no-fund pnpm@10.13.1
fi
pnpm install --frozen-lockfile
pnpm run workspace:build
pnpm run workspace:check
pnpm run workspace:test
