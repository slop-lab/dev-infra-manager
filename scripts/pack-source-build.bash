#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/pack-source-build.bash OUTPUT_DIRECTORY" >&2
  exit 2
fi

obsolete_inputs=(
  DIM_SOURCE_REF
  DIM_SOURCE_CORE_COMMIT
  DIM_SOURCE_PLUGIN_DNS_CLOUDFLARE_COMMIT
  DIM_SOURCE_PLUGIN_EXTERNAL_URLS_COMMIT
  DIM_SOURCE_REPOSITORY_BASE_URL
)
for variable in "${obsolete_inputs[@]}"; do
  if [[ -n "${!variable+x}" ]]; then
    echo "$variable is not supported; use DIM_SOURCE_ROOT_COMMIT for the reviewed monorepo commit" >&2
    exit 2
  fi
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
commit="${DIM_SOURCE_ROOT_COMMIT:-$(git -C "$repo_root" rev-parse HEAD)}"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DIM_SOURCE_ROOT_COMMIT must be exactly 40 lowercase hexadecimal characters" >&2
  exit 2
fi
resolved_commit="$(git -C "$repo_root" rev-parse "$commit")"
if [[ "$resolved_commit" != "$commit" ]]; then
  echo "root resolved to $resolved_commit instead of required commit $commit" >&2
  exit 1
fi
printf '[source] root %s\n' "$resolved_commit"

output_directory="$1"
mkdir -p "$output_directory"
output_directory="$(cd -- "$output_directory" && pwd)"
local_root="$repo_root/.local"
source_root="$local_root/production-source"
source_archive="$local_root/production-source.$$.tar"
mkdir -p "$source_root"
find "$source_root" -mindepth 1 -depth -delete
cleanup() {
  rm -f -- "$source_archive"
}
trap cleanup EXIT

git -C "$repo_root" archive --format=tar --output "$source_archive" "$commit" -- \
  pnpm-lock.yaml \
  core \
  plugin-dns-cloudflare \
  plugin-external-urls
tar -xf "$source_archive" -C "$source_root"

cat >"$source_root/package.json" <<'EOF'
{"name":"dim-production-source-build","private":true}
EOF
cat >"$source_root/pnpm-workspace.yaml" <<'EOF'
packages:
  - core/packages/core
  - core/packages/cli
  - core/packages/installer
  - core/packages/controller-proxy
  - core/packages/contracts/*
  - plugin-dns-cloudflare
  - plugin-external-urls
linkWorkspacePackages: true
EOF

aggregate_lock="$source_root/pnpm-lock.yaml"
if [[ ! -f "$aggregate_lock" ]]; then
  echo "aggregate source-build lock is missing from reviewed commit $commit" >&2
  exit 1
fi
source_version="$(node -p "require('$source_root/core/package.json').version")"
aggregate_lock_sha="$(sha256sum "$aggregate_lock" | cut -d ' ' -f 1)"
[[ "$aggregate_lock_sha" =~ ^[0-9a-f]{64}$ ]]
aggregate_sha="$({
  printf 'root=%s\n' "$commit"
  printf 'aggregate-lock-sha256=%s\n' "$aggregate_lock_sha"
} | sha256sum | cut -d ' ' -f 1)"
[[ "$aggregate_sha" =~ ^[0-9a-f]{64}$ ]]
export DIM_LOCAL_BUILD_VERSION="$source_version-local-$aggregate_sha"
printf 'root=%s\naggregate-lock-sha256=%s\n' "$commit" "$aggregate_lock_sha" >"$source_root/.dim-source-state"

echo "[source] install production build dependencies"
pnpm --dir "$source_root" install --frozen-lockfile

echo "[source] build production packages"
pnpm --dir "$source_root/core" run build
pnpm --dir "$source_root/plugin-dns-cloudflare" run build
pnpm --dir "$source_root/plugin-external-urls" run build

echo "[source] create install bundle"
node "$repo_root/scripts/pack-local-packages.mjs" "$source_root" "$output_directory"
