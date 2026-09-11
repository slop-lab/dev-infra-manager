#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "Usage: bash verification/scripts/pack-local-packages.bash OUTPUT_DIRECTORY" >&2
  exit 2
fi

output_directory="$1"
mkdir -p "$output_directory"
output_directory="$(cd -- "$output_directory" && pwd)"

cd "$repo_root"
echo "[packages] build workspace"
source_version="$(node -p 'require("./core/package.json").version')"
source_sha="$(git -C core rev-parse --short=12 HEAD)"
local_dirty=""
for repository in core plugin-dns-cloudflare plugin-external-urls; do
  if [[ -n "$(git -C "$repository" status --porcelain)" ]]; then
    local_dirty=-dirty
    break
  fi
done
export DIM_LOCAL_BUILD_VERSION="$source_version-local-$source_sha$local_dirty"
pnpm run workspace:build >/dev/null

echo "[packages] create pnpm tarballs"
node "$script_dir/pack-local-packages.mjs" "$output_directory"
