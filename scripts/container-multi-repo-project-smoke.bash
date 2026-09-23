#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

bash "$script_dir/two-repository-materialization-smoke.bash"

echo container-multi-repo-project-smoke-ok
