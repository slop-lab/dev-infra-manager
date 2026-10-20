#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
workspace="${DIM_EXAMPLE_WORKSPACE:-native-basic-dev}"
cleanup() {
  status=$?
  if ! "${DIM_BIN:-dim}" discard "$workspace" --yes; then
    if [[ "$status" == 0 ]]; then status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
bash scripts/dev.bash
"${DIM_BIN:-dim}" exec "${DIM_EXAMPLE_WORKSPACE:-native-basic-dev}" -- bash .dim/ci/jobs/source.bash
