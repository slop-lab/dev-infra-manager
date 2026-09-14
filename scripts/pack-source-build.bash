#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/pack-source-build.bash OUTPUT_DIRECTORY" >&2
  exit 2
fi

repositories=(core plugin-dns-cloudflare plugin-external-urls)
commit_variables=(
  DIM_SOURCE_CORE_COMMIT
  DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT
  DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT
)
commits=()

if [[ -n "${DIM_SOURCE_REF+x}" ]]; then
  echo "DIM_SOURCE_REF is not supported; provide one exact commit for each production repository" >&2
  exit 2
fi

for index in "${!repositories[@]}"; do
  repository="${repositories[$index]}"
  commit_variable="${commit_variables[$index]}"
  commit="${!commit_variable:-}"
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "$commit_variable must be exactly 40 lowercase hexadecimal characters for $repository" >&2
    exit 2
  fi
  commits+=("$commit")
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_directory="$1"
mkdir -p "$output_directory"
output_directory="$(cd -- "$output_directory" && pwd)"
source_root="$repo_root/.local/production-source"
mkdir -p "$source_root"
find "$source_root" -mindepth 1 -depth -delete

origin_url="${DIM_SOURCE_ROOT_URL:-$(git -C "$repo_root" remote get-url origin)}"
origin_without_suffix="${origin_url%.git}"
origin_repository="${origin_without_suffix##*/}"
repository_base="${origin_url%/*}"

for index in "${!repositories[@]}"; do
  repository="${repositories[$index]}"
  commit="${commits[$index]}"
  if [[ -n "${DIM_SOURCE_REPOSITORY_BASE_URL:-}" ]]; then
    source_url="${DIM_SOURCE_REPOSITORY_BASE_URL%/}/$repository.git"
  elif [[ "$origin_repository" == root ]]; then
    source_url="$repository_base/$repository.git"
  else
    source_url="$origin_url"
  fi
  echo "[source] clone $repository"
  git clone --quiet --no-checkout "$source_url" "$source_root/$repository"
  git -C "$source_root/$repository" fetch --quiet origin "$commit"
  git -C "$source_root/$repository" checkout --quiet --detach "$commit"
  resolved_commit="$(git -C "$source_root/$repository" rev-parse HEAD)"
  if [[ "$resolved_commit" != "$commit" ]]; then
    echo "$repository resolved to $resolved_commit instead of required commit $commit" >&2
    exit 1
  fi
  printf '[source] %s %s\n' "$repository" "$resolved_commit"
done

source_version="$(node -p "require('$source_root/core/package.json').version")"
aggregate_sha="$({
  for index in "${!repositories[@]}"; do
    printf '%s=%s\n' "${repositories[$index]}" "${commits[$index]}"
  done
} | sha256sum | cut -d ' ' -f 1)"
[[ "$aggregate_sha" =~ ^[0-9a-f]{64}$ ]]
export DIM_LOCAL_BUILD_VERSION="$source_version-local-$aggregate_sha"

echo "[source] install production build dependencies"
for repository in "${repositories[@]}"; do
  pnpm --dir "$source_root/$repository" install --frozen-lockfile
done

echo "[source] build production packages"
local_dirty=""
for repository in "${repositories[@]}"; do
  if [[ -n "$(git -C "$source_root/$repository" status --porcelain)" ]]; then
    local_dirty=-dirty
    break
  fi
done
export DIM_LOCAL_BUILD_VERSION="$source_version-local-$aggregate_sha$local_dirty"
pnpm --dir "$source_root/core" run build
for repository in "${repositories[@]:1}"; do
  pnpm --dir "$source_root/$repository" link "$source_root/core/packages/core"
  pnpm --dir "$source_root/$repository" link "$source_root/core/packages/contracts/external-url"
done
pnpm --dir "$source_root/plugin-dns-cloudflare" run build
pnpm --dir "$source_root/plugin-external-urls" run build

echo "[source] create install bundle"
node "$repo_root/scripts/pack-local-packages.mjs" "$source_root" "$output_directory"
