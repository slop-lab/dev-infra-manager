#!/usr/bin/env bash
set -euo pipefail

project="${1:-ci-runner-example}"
repositories="${2:-$PWD/ci-runner-example-repositories}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project" \
  --repos "$repositories/root/.dim/repos.yml" \
  --yes

echo "Registered Project '$project'"
