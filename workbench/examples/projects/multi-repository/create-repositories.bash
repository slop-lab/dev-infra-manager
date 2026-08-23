#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD/example-repositories}"
repo_root="$(cd -- "$example_dir/../../.." && pwd)"
# shellcheck source=../../../scripts/lib/example-repositories.bash
source "$repo_root/scripts/lib/example-repositories.bash"

dim_materialize_example_repositories "$example_dir" "$target_dir"
echo "Created example repositories in $target_dir"
