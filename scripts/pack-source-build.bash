#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/pack-source-build.bash OUTPUT_DIRECTORY" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_directory="$1"
mkdir -p "$output_directory"
output_directory="$(cd -- "$output_directory" && pwd)"
source_root="$repo_root/.local/production-source"
mkdir -p "$source_root"
find "$source_root" -mindepth 1 -depth -delete

origin_url="$(git -C "$repo_root" remote get-url origin)"
case "$origin_url" in
  *.git) repository_base="${origin_url%/*}" ;;
  *) repository_base="${origin_url%/*}" ;;
esac
repository_base="${DIM_SOURCE_REPOSITORY_BASE_URL:-$repository_base}"
source_ref="${DIM_SOURCE_REF:-main}"
repositories=(core plugin-dns-cloudflare plugin-external-urls)

for repository in "${repositories[@]}"; do
  echo "[source] clone $repository@$source_ref"
  git clone --quiet --single-branch --branch "$source_ref" \
    "$repository_base/$repository.git" "$source_root/$repository"
  printf '[source] %s %s\n' "$repository" \
    "$(git -C "$source_root/$repository" rev-parse HEAD)"
done

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

echo "[source] install production build dependencies"
pnpm --dir "$source_root" install --lockfile=false

echo "[source] build production packages"
pnpm --dir "$source_root/core" run build
pnpm --dir "$source_root/plugin-dns-cloudflare" run build
pnpm --dir "$source_root/plugin-external-urls" run build

echo "[source] create install bundle"
node "$repo_root/scripts/pack-local-packages.mjs" "$source_root" "$output_directory"
