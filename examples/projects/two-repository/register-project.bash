#!/usr/bin/env bash
set -euo pipefail

project="${1:-two-repository}"
repositories="${2:-$PWD/two-repository-repositories}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project" \
  --bootstrap-git-url "$repositories/root" \
  --bootstrap-git-ref main \
  --apply-repos

echo "Registered two-repository Project '$project'"
