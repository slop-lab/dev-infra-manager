#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 1 ]] || { echo 'usage: serve-installed-control-plane.bash PRIVATE_RUNTIME' >&2; exit 2; }
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo_root"
: "${DIM_EXAMPLE_REMOTE_SETUP:?private transferred operator directory required}"
source scripts/examples/installed-control-plane-environment.bash
examples_control_plane_environment "$1"
binding="$(examples_control_plane_binding)"
[[ -f "$1/prepared" && ! -L "$1/prepared" && "$(<"$1/prepared")" == "$binding" ]] || {
  echo 'control-plane runtime has no matching completed preparation' >&2; exit 2;
}
if [[ "${DIM_PRACTICAL_CI_REQUIRED:-}" == 1 ]]; then
  exec node tests/scenarios/selected-host/ci/controlPlane.ts "$DIM_EXAMPLE_REMOTE_SETUP"
else
  exec node scripts/examples/serve-control-plane.ts "$DIM_EXAMPLE_REMOTE_SETUP"
fi
