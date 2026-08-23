#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-$PWD/example-repositories}"
repo_root="$(cd -- "$example_dir/../../.." && pwd)"
# shellcheck source=../../../scripts/lib/example-repositories.bash
source "$repo_root/scripts/lib/example-repositories.bash"

dim_materialize_example_repositories "$example_dir" "$destination"
echo "Created repository in $destination/root"
