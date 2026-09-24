#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
package_root="$(mktemp -d /tmp/dim-local-install.XXXXXX)"
install_prefix="${DIM_INSTALL_PREFIX:-$HOME/.local}"

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

cd "$repo_root"
bash verification/scripts/pack-local-packages.bash "$package_root"

plugins=(
  @slop-lab/dim-plugin-dns-cloudflare
  @slop-lab/dim-plugin-external-urls
)

if command -v mise >/dev/null 2>&1; then
  echo "[packages] use the mise-managed DIM installer facade"
  dim_command=(mise exec -- dim)
  staged_installer=""
else
  installer_tarballs=("$package_root"/slop-lab-dim-installer-*.tgz)
  test "${#installer_tarballs[@]}" -eq 1 && test -f "${installer_tarballs[0]}"
  staged_installer="$package_root/installer"
  npm install --prefix "$staged_installer" --no-save --no-fund --no-audit "${installer_tarballs[0]}"
  dim_command=("$staged_installer/node_modules/.bin/dim")
fi

"${dim_command[@]}" install-cli --local-packages "$package_root" --no-local-bin
if [[ -n "$staged_installer" ]]; then
  npm install --global --prefix "$install_prefix" "${installer_tarballs[0]}"
  dim_command=("$install_prefix/bin/dim")
fi
"${dim_command[@]}" enable-plugin "${plugins[@]}"
echo "Installed the local DIM build and enabled its DNS and External URLs plugins"
