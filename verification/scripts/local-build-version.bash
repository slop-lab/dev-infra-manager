#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash verification/scripts/local-build-version.bash" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
root_repository="${DIM_ROOT_REPOSITORY_PATH:-$repo_root}"
aggregate_lock="$root_repository/pnpm-lock.yaml"
local_dirty=""

if [[ ! -f "$aggregate_lock" ]]; then
  echo "aggregate source-build lock is missing: $aggregate_lock" >&2
  exit 1
fi

cd "$repo_root"
commit="$(GIT_MASTER=1 git -C "$root_repository" rev-parse HEAD)"
repository_status="$(GIT_MASTER=1 git -C "$root_repository" status --porcelain --untracked-files=no)"
if [[ -n "$repository_status" ]]; then
  local_dirty=-dirty
fi

source_version="$(node -p 'require(process.argv[1]).version' "$repo_root/core/package.json")"
aggregate_lock_sha="$(sha256sum "$aggregate_lock" | cut -d ' ' -f 1)"
[[ "$aggregate_lock_sha" =~ ^[0-9a-f]{64}$ ]]
aggregate_sha="$({
  printf 'root=%s\n' "$commit"
  printf 'aggregate-lock-sha256=%s\n' "$aggregate_lock_sha"
} | sha256sum | cut -d ' ' -f 1)"
[[ "$aggregate_sha" =~ ^[0-9a-f]{64}$ ]]

printf '%s-local-%s%s\n' "$source_version" "$aggregate_sha" "$local_dirty"
