#!/usr/bin/env bash
set -euo pipefail

project="${1:-example}"
repositories="${2:-$PWD/example-repositories}"
dim_bin="${DIM_BIN:-dim}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../scripts/lib/example-repositories.bash
source "$repo_root/scripts/lib/example-repositories.bash"

dim_register_example_repositories "$project" "$repositories" "$dim_bin"
"$dim_bin" repo plan "$project" --json >/dev/null

echo "Registered Project '$project'"
