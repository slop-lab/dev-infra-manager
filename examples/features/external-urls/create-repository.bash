#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="${1:-$PWD/example-repository}"

if [[ -e "$destination" ]]; then
  echo "already exists: $destination" >&2
  exit 2
fi

cp -R "$example_dir/repo" "$destination"
git init --initial-branch=main "$destination"
git -C "$destination" add -A
git -C "$destination" commit -m "initial external-url example"

echo "Created repository in $destination"
