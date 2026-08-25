#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/install-source-build.bash" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$repo_root/.local/dim-packages"
mkdir -p "$package_root"
find "$package_root" -mindepth 1 -depth -delete
bash "$repo_root/scripts/pack-source-build.bash" "$package_root"

if command -v mise >/dev/null 2>&1; then
  dim_command=(mise exec -- dim)
else
  dim_command=(dim)
fi

echo "[host] install package bundle"
"${dim_command[@]}" install-cli --local-packages "$package_root" --no-local-bin

echo "[host] restart the managed controller"
"${dim_command[@]}" controller restart
"${dim_command[@]}" --version
