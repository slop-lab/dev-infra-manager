#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD/example-repositories}"

mkdir -p "$target_dir"
for name in root web secrets; do
  destination="$target_dir/$name"
  if [[ -e "$destination" ]]; then
    echo "already exists: $destination" >&2
    exit 2
  fi
  cp -R "$example_dir/repos/$name" "$destination"
  git init --initial-branch=main "$destination"
  git -C "$destination" add -A
  git -C "$destination" commit -m "initial example-$name"
done

root_url="$(realpath "$target_dir/root")"
web_url="$(realpath "$target_dir/web")"
secrets_url="$(realpath "$target_dir/secrets")"
manifest="$target_dir/root/.dim/repos.yml"
temporary_manifest="$manifest.tmp"
jq \
  --arg root "$root_url" \
  --arg web "$web_url" \
  --arg secrets "$secrets_url" \
  '
    .repositories.root.url = $root
    | .repositories.web.url = $web
    | .repositories.secrets.url = $secrets
  ' \
  "$manifest" >"$temporary_manifest"
mv "$temporary_manifest" "$manifest"
git -C "$target_dir/root" add .dim/repos.yml
git -C "$target_dir/root" commit --amend --no-edit

echo "Created root, web, and secrets repositories in $target_dir"
