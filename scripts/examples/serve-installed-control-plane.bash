#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"
: "${DIM_EXAMPLE_PACKAGE_BUNDLE:?exact source package bundle required}"
: "${DIM_EXAMPLE_REMOTE_SETUP:?private transferred operator directory required}"
trial="$(mktemp -d "${TMPDIR:-/tmp}/dim-examples-control-plane.XXXXXXXX")"
trap 'rm -rf -- "$trial"' EXIT
export npm_config_cache="$trial/npm-cache" npm_config_userconfig=/dev/null npm_config_ignore_scripts=true
installer="$(node scripts/examples/installer-artifact.ts "$DIM_EXAMPLE_PACKAGE_BUNDLE")"
npm install --prefix "$trial/facade" --no-save --no-audit --no-fund "$installer"
export DIM_EXAMPLE_DIM_BIN="$trial/facade/node_modules/.bin/dim"
export XDG_CONFIG_HOME="$trial/config" XDG_DATA_HOME="$trial/data" XDG_STATE_HOME="$trial/state" XDG_RUNTIME_DIR="$trial/run"
export DIM_CONFIG_PATH="$trial/config/dim.json" DIM_DATA_HOME="$trial/data/dim" DIM_STATE_ROOT="$trial/state/dim"
mkdir -m 0700 -p "$XDG_RUNTIME_DIR"
node scripts/examples/run.ts all install-control-plane
if [[ "${DIM_PRACTICAL_CI_REQUIRED:-}" == 1 ]]; then
  node tests/scenarios/selected-host/ci/controlPlane.ts "$DIM_EXAMPLE_REMOTE_SETUP"
else
  node scripts/examples/serve-control-plane.ts "$DIM_EXAMPLE_REMOTE_SETUP"
fi
