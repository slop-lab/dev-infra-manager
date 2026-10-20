#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"
: "${DIM_EXAMPLE_PACKAGE_BUNDLE:?exact source package bundle required}"
: "${DIM_EXAMPLE_REMOTE_SETUP:?private transferred operator directory required}"
trial="$(mktemp -d "${TMPDIR:-/tmp}/dim-examples-control-plane.XXXXXXXX")"
trap 'rm -rf -- "$trial"' EXIT
export npm_config_cache="$trial/npm-cache" npm_config_userconfig=/dev/null npm_config_ignore_scripts=true
installer="$(node --input-type=module - "$DIM_EXAMPLE_PACKAGE_BUNDLE" <<'JS'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.argv[2], manifest = JSON.parse(readFileSync(join(directory, 'packages.json'), 'utf8'));
const entry = manifest.packages.find((entry) => entry.name === '@slop-lab/dim-installer');
if (!entry || entry.version !== '0.10.0') throw new Error('exact recipe installer version required');
console.log(join(directory, entry.file));
JS
)"
npm install --prefix "$trial/facade" --no-save --no-audit --no-fund "$installer"
export DIM_EXAMPLE_DIM_BIN="$trial/facade/node_modules/.bin/dim"
export XDG_CONFIG_HOME="$trial/config" XDG_DATA_HOME="$trial/data" XDG_STATE_HOME="$trial/state" XDG_RUNTIME_DIR="$trial/run"
export DIM_CONFIG_PATH="$trial/config/dim.json" DIM_DATA_HOME="$trial/data/dim" DIM_STATE_ROOT="$trial/state/dim"
mkdir -m 0700 -p "$XDG_RUNTIME_DIR"
node scripts/examples/run.ts all install-control-plane
node scripts/examples/serve-control-plane.ts "$DIM_EXAMPLE_REMOTE_SETUP"
