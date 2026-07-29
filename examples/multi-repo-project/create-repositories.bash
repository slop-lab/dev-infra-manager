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

echo "Created root, web, and secrets repositories in $target_dir"
