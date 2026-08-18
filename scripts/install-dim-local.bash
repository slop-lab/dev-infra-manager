#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$(mktemp -d /tmp/dim-local-install.XXXXXX)"
install_prefix="${DIM_INSTALL_PREFIX:-$HOME/.local}"

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

cd "$repo_root"
bash scripts/pack-local-packages.bash "$package_root"

if command -v mise >/dev/null 2>&1; then
  echo "[packages] install through the mise-managed DIM installer facade"
  mise exec -- dim install-cli --local-packages "$package_root" --no-local-bin
  echo "Installed the local DIM build behind the mise-managed dim facade"
  exit 0
fi

local_tarballs=()
while IFS= read -r tarball; do
  case "$(basename "$tarball")" in
    *dim-installer*) ;;
    *) local_tarballs+=("$tarball") ;;
  esac
done < <(find "$package_root" -maxdepth 1 -type f -name '*.tgz' -print | sort)
test "${#local_tarballs[@]}" -gt 0

npm install --global --prefix "$install_prefix" "${local_tarballs[@]}"
echo "Installed $install_prefix/bin/dim (ensure $install_prefix/bin is in PATH)"
