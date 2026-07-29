#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/pack-local-packages.bash OUTPUT_DIRECTORY" >&2
  exit 2
fi

output_directory="$1"
mkdir -p "$output_directory"
output_directory="$(cd -- "$output_directory" && pwd)"

cd "$repo_root"
echo "[packages] build workspace"
pnpm run workspace:build >/dev/null

echo "[packages] create npm tarballs"
node "$script_dir/pack-local-packages.mjs" "$output_directory"
