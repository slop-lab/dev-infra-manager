#!/usr/bin/env bash
set -euo pipefail

project="${1:-external}"
repository="${2:-$PWD/example-repository}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project"
"$dim_bin" repo add "$project" root "$repository" \
  --root --ref main --protect main

echo "Registered Project '$project'"
