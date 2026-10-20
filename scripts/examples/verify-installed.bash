#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"
docker info >/dev/null
trial="$(mktemp -d "${TMPDIR:-/tmp}/dim-installed-examples.XXXXXXXX")"
image="dim-examples-workspace:$(git rev-parse --short HEAD)-$$"
export npm_config_cache="$trial/npm-cache" npm_config_userconfig=/dev/null npm_config_ignore_scripts=true
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -x "${DIM_EXAMPLE_DIM_BIN:-}" ]]; then
    "$DIM_EXAMPLE_DIM_BIN" controller stop || status=1
  fi
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf -- "$trial"
  exit "$status"
}
trap cleanup EXIT
if [[ -z "${DIM_EXAMPLE_PACKAGE_BUNDLE:-}" ]]; then
  mkdir -p "$trial/packages"
  node scripts/pack-local-packages.ts "$repo_root" "$trial/packages"
  export DIM_EXAMPLE_PACKAGE_BUNDLE="$trial/packages"
fi
installer="$(node --input-type=module - "$DIM_EXAMPLE_PACKAGE_BUNDLE" <<'JS'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2], manifest = JSON.parse(readFileSync(join(root, 'packages.json'), 'utf8'));
const entry = manifest.packages.find((entry) => entry.name === '@slop-lab/dim-installer');
if (!entry || entry.version !== '0.10.0') throw new Error('examples require the exact recipe artifact version');
console.log(join(root, entry.file));
JS
)"
npm install --prefix "$trial/facade" --no-save --no-audit --no-fund "$installer"
export DIM_EXAMPLE_DIM_BIN="$trial/facade/node_modules/.bin/dim"
export XDG_CONFIG_HOME="$trial/config" XDG_DATA_HOME="$trial/data" XDG_STATE_HOME="$trial/state" XDG_RUNTIME_DIR="$trial/run"
export DIM_CONFIG_PATH="$trial/config/dim.json" DIM_DATA_HOME="$trial/data/dim" DIM_STATE_ROOT="$trial/state/dim" DIM_MANAGED_STATE_ROOT="$trial/managed"
export DIM_INSTALL_PREFIX="$trial/prefix"
export DIM_EXAMPLE_WORKSPACE_IMAGE="$image"
mkdir -m 0700 -p "$XDG_RUNTIME_DIR"
"$DIM_EXAMPLE_DIM_BIN" installer install core --with-managed --local-packages "$DIM_EXAMPLE_PACKAGE_BUNDLE" --no-local-bin
node scripts/examples/run.ts all install-host
if [[ -z "${DIM_EXAMPLE_REMOTE_ENDPOINT:-}" ]]; then
  node scripts/examples/run.ts all install-control-plane
fi
DIM_LOCAL_SOURCE_ROOT="$PWD" DIM_LOCAL_IMAGE_BUILD_REF="$image" bash scripts/build-workspace-image.bash
node scripts/examples/verify-vm.ts
