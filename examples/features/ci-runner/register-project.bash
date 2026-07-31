#!/usr/bin/env bash
set -euo pipefail

project="${1:-ci-runner-example}"
repository="${2:-$PWD/ci-runner-example-repository}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project" \
  --repos "$repository/.dim/repos.yml" \
  --yes

echo "Registered Project '$project'"
