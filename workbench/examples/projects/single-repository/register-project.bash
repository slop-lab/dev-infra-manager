#!/usr/bin/env bash
set -euo pipefail

project="${1:-single-app}"
repositories="${2:-$PWD/single-repository}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project" \
  --root app \
  --bootstrap-git-url "$repositories/app" \
  --bootstrap-git-ref main

echo "Registered single-repository Project '$project' without branch protection"
