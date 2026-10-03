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
legacy_source_root="$repo_root/.local/production-source"
if [[ -L "$legacy_source_root" ]]; then
  echo "refusing symlinked source-build path: $legacy_source_root" >&2
  exit 1
fi

commit="${DIM_SOURCE_ROOT_COMMIT:-$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" rev-parse HEAD)}"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DIM_SOURCE_ROOT_COMMIT must be exactly 40 lowercase hexadecimal characters" >&2
  exit 2
fi
resolved_commit="$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" rev-parse --verify "${commit}^{commit}")"
if [[ "$resolved_commit" != "$commit" ]]; then
  echo "root resolved to $resolved_commit instead of required commit $commit" >&2
  exit 1
fi
printf '[source] root %s\n' "$resolved_commit"

output_directory="$1"
if [[ -L "$output_directory" ]]; then
  echo "refusing symlinked package output: $output_directory" >&2
  exit 1
fi
output_parent="$(dirname -- "$output_directory")"
if [[ ! -d "$output_parent" || -L "$output_parent" ]]; then
  echo "package output parent must be an existing non-symlink directory: $output_parent" >&2
  exit 1
fi
output_parent="$(cd -- "$output_parent" && pwd -P)"
output_directory="$output_parent/$(basename -- "$output_directory")"
if [[ -e "$output_directory" && ! -d "$output_directory" ]]; then
  echo "package output must be a directory: $output_directory" >&2
  exit 1
fi

output_stage="$(mktemp -d "$output_parent/.dim-packages.XXXXXX")"
output_backup=""
source_archive="$(mktemp "${TMPDIR:-/tmp}/dim-production-source.XXXXXX.tar")"
owns_source_root=0
published=0
if [[ -n "${DIM_SOURCE_BUILD_ROOT:-}" ]]; then
  source_root="$DIM_SOURCE_BUILD_ROOT"
  if [[ -e "$source_root" || -L "$source_root" ]]; then
    echo "source build staging path already exists: $source_root" >&2
    exit 1
  fi
  mkdir -m 700 -- "$source_root"
else
  source_root="$(mktemp -d "${TMPDIR:-/tmp}/dim-production-source.XXXXXX")"
  owns_source_root=1
fi

cleanup() {
  status="$?"
  rm -f -- "$source_archive"
  if [[ "$published" -eq 0 ]]; then
    rm -rf -- "$output_stage"
    if [[ -n "$output_backup" && -d "$output_backup" && ! -e "$output_directory" ]]; then
      mv -- "$output_backup" "$output_directory"
    fi
  fi
  if [[ "$owns_source_root" -eq 1 ]]; then
    rm -rf -- "$source_root"
  fi
  exit "$status"
}
trap cleanup EXIT

GIT_NO_REPLACE_OBJECTS=1 git -C "$repo_root" archive --format=tar --output "$source_archive" "$commit" -- \
  pnpm-lock.yaml \
  core \
  plugin-dns-cloudflare \
  plugin-external-urls \
  plugin-host-mirrors
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
  - plugin-host-mirrors
linkWorkspacePackages: true
EOF

aggregate_lock="$source_root/pnpm-lock.yaml"
if [[ ! -f "$aggregate_lock" || -L "$aggregate_lock" ]]; then
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
pnpm --dir "$source_root/plugin-host-mirrors" run build

echo "[source] create install bundle"
node "$repo_root/scripts/pack-local-packages.mjs" "$source_root" "$output_stage"
cp -- "$source_root/.dim-source-state" "$output_stage/.dim-source-state"

if [[ -d "$output_directory" ]]; then
  output_backup="$(mktemp -d "$output_parent/.dim-packages-backup.XXXXXX")"
  rmdir -- "$output_backup"
  mv -- "$output_directory" "$output_backup"
fi
mv -- "$output_stage" "$output_directory"
published=1
if [[ -n "$output_backup" ]]; then
  rm -rf -- "$output_backup"
fi
