#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD/ci-runner-example-repositories}"

if [[ -e "$target_dir" ]]; then
  echo "already exists: $target_dir" >&2
  exit 2
fi

mkdir -p "$target_dir"
for name in root app; do
  cp -R "$example_dir/repos/$name" "$target_dir/$name"
  git init --initial-branch=main "$target_dir/$name"
  git -C "$target_dir/$name" add -A
  git -C "$target_dir/$name" commit -m "initial CI runner example-$name"
done

root_url="$(realpath "$target_dir/root")"
app_url="$(realpath "$target_dir/app")"
manifest="$target_dir/root/.dim/repos.yml"
temporary_manifest="$manifest.tmp"
jq --arg root "$root_url" --arg app "$app_url" \
  '.repositories.root.url = $root | .repositories.app.url = $app' \
  "$manifest" >"$temporary_manifest"
mv "$temporary_manifest" "$manifest"
git -C "$target_dir/root" add .dim/repos.yml
git -C "$target_dir/root" commit --amend --no-edit

echo "Created CI runner example repositories in $target_dir"
