#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 <package-directory>" >&2
  exit 2
fi

package_directory="$(cd -- "$1" && pwd)"
output_directory="$(mktemp -d /tmp/dim-pnpm-pack-XXXXXX)"
trap 'rm -rf "$output_directory"' EXIT

pnpm --dir "$package_directory" pack --pack-destination "$output_directory"
