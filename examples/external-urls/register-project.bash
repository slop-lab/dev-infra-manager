#!/usr/bin/env bash
set -euo pipefail

project="${1:-external}"
repository="${2:-$PWD/example-repository}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project"
"$dim_bin" repo create "$project" root --root --ref main --protect main
"$dim_bin" x git -C "$repository" push \
  "$("$dim_bin" repo url "$project" root)" main
"$dim_bin" repo protect "$project" root

echo "Registered Project '$project'"
