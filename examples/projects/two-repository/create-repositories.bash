#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD/two-repository-repositories}"
repo_root="$(cd -- "$example_dir/../../.." && pwd)"
# shellcheck source=../../../verification/scripts/lib/example-repositories.bash
source "$repo_root/verification/scripts/lib/example-repositories.bash"

dim_materialize_example_repositories "$example_dir" "$target_dir"
echo "Created root and app repositories in $target_dir"
