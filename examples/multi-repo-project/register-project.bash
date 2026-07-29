#!/usr/bin/env bash
set -euo pipefail

project="${1:-example}"
repositories="${2:-$PWD/example-repositories}"
dim_bin="${DIM_BIN:-dim}"

"$dim_bin" project create "$project"

for name in root web secrets; do
  root_flag=()
  [[ "$name" == root ]] && root_flag=(--root --ref main)

  "$dim_bin" repo create "$project" "$name" \
    "${root_flag[@]}" --protect main
  "$dim_bin" x git -C "$repositories/$name" push \
    "$("$dim_bin" repo url "$project" "$name")" main
  "$dim_bin" repo protect "$project" "$name"
done

echo "Registered Project '$project'"
