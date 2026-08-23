#!/usr/bin/env bash
set -euo pipefail

project="${1:-shared-upstream-example}"
materialized="${2:-$PWD/shared-upstream-example}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project" \
  --repos "$materialized/repositories/root/.dim/repos.yml" \
  --yes

echo "Registered Project '$project'"
