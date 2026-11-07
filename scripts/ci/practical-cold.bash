#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 0 ]] || exit 2
exec bash scripts/ci/practical.bash --cold-install
