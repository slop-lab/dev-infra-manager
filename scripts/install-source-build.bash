#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/install-source-build.bash" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-source-install.XXXXXX)"
package_root="$work_dir/packages"

cleanup() {
  find "$work_dir" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

mkdir "$package_root"
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
