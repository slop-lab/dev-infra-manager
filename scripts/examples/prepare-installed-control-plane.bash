#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 1 ]] || { echo 'usage: prepare-installed-control-plane.bash PRIVATE_RUNTIME' >&2; exit 2; }
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"
source scripts/examples/installed-control-plane-environment.bash
examples_control_plane_environment "$1"
[[ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'control-plane preparation requires an empty private runtime' >&2; exit 2; }
umask 077
: >"$1/preparing"
mkdir -m 0700 -p "$XDG_RUNTIME_DIR"
installer="$(node scripts/examples/installer-artifact.ts "$DIM_EXAMPLE_PACKAGE_BUNDLE")"
npm install --prefix "$1/facade" --no-save --no-audit --no-fund "$installer"
node scripts/examples/run.ts all install-control-plane
if [[ "${DIM_PRACTICAL_CI_REQUIRED:-0}" == 1 ]]; then
  node tests/scenarios/selected-host/ci/installControlPlane.ts
fi
binding="$(examples_control_plane_binding)"
printf '%s\n' "$binding" >"$1/prepared"
printf '%s\n' 'separate-control-plane-prepared: matching installed fixture plugins ready for service startup'
