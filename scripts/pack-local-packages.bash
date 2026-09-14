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
repositories=(core plugin-dns-cloudflare plugin-external-urls)
commits=()
local_dirty=""
for repository in "${repositories[@]}"; do
  commits+=("$(GIT_MASTER=1 git -C "$repository" rev-parse HEAD)")
  repository_status="$(GIT_MASTER=1 git -C "$repository" status --porcelain)"
  if [[ -n "$repository_status" ]]; then
    local_dirty=-dirty
  fi
done
aggregate_sha="$({
  for index in "${!repositories[@]}"; do
    printf '%s=%s\n' "${repositories[$index]}" "${commits[$index]}"
  done
} | sha256sum | cut -d ' ' -f 1)"
[[ "$aggregate_sha" =~ ^[0-9a-f]{64}$ ]]
export DIM_LOCAL_BUILD_VERSION="$source_version-local-$aggregate_sha$local_dirty"
pnpm run workspace:build >/dev/null

echo "[packages] create pnpm tarballs"
node "$script_dir/pack-local-packages.mjs" "$output_directory"
