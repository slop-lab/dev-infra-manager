#!/usr/bin/env bash
set -euo pipefail

project="${1:-example}"
repositories="${2:-$PWD/example-repositories}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project" \
  --repos "$repositories/root/.dim/repos.yml" \
  --yes
"$dim_bin" repo plan "$project" --json >/dev/null

echo "Registered Project '$project'"
