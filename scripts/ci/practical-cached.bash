#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 0 ]] || { echo 'cached qualification accepts no path overrides' >&2; exit 2; }
# This fixed path is supplied by the reviewed digest-pinned supervisor image's
# existing read-only tools mount, never a candidate-selected host cache path.
exec bash scripts/ci/practical.bash --baseline-manifest /mnt/dim-tools/baselines/manifest.json
