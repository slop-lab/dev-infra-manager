#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD/ci-runner-example-repository}"

if [[ -e "$target_dir" ]]; then
  echo "already exists: $target_dir" >&2
  exit 2
fi

cp -R "$example_dir/repo" "$target_dir"
repository_url="$(realpath "$target_dir")"
manifest="$target_dir/.dim/repos.yml"
temporary_manifest="$manifest.tmp"
jq --arg url "$repository_url" \
  '.repositories.root.url = $url' \
  "$manifest" >"$temporary_manifest"
mv "$temporary_manifest" "$manifest"

git init --initial-branch=main "$target_dir"
git -C "$target_dir" add -A
git -C "$target_dir" commit -m "initial CI runner example"

echo "Created CI runner example repository in $target_dir"
