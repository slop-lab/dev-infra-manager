#!/usr/bin/env bash
set -euo pipefail

project="${1:-external}"
repositories="${2:-$PWD/example-repositories}"
dim_bin="${DIM_BIN:-dim}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../../verification/scripts/lib/example-repositories.bash
source "$repo_root/verification/scripts/lib/example-repositories.bash"

dim_register_example_repositories "$project" "$repositories" "$dim_bin"

echo "Registered Project '$project'"
