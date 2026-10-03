#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
package_root="$(mktemp -d /tmp/dim-local-install.XXXXXX)"
install_prefix="${DIM_INSTALL_PREFIX:-$HOME/.local}"
staged_installer=""

cleanup() {
  find "$package_root" -depth -delete 2>/dev/null || true
  if [[ -n "$staged_installer" ]]; then
    find "$staged_installer" -depth -delete 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$repo_root"
bash verification/scripts/pack-local-packages.bash "$package_root"

plugins=(
  @slop-lab/dim-plugin-dns-cloudflare
  @slop-lab/dim-plugin-external-urls
  @slop-lab/dim-plugin-host-mirrors
)

installer_tarballs=("$package_root"/slop-lab-dim-installer-*.tgz)
test "${#installer_tarballs[@]}" -eq 1 && test -f "${installer_tarballs[0]}"
staged_installer="$(mktemp -d "${TMPDIR:-/tmp}/dim-target-installer.XXXXXX")"
if command -v mise >/dev/null 2>&1; then
  echo "[packages] use mise to run the target DIM installer facade"
  npm_command=(mise exec -- npm)
  dim_command=(mise exec -- "$staged_installer/node_modules/.bin/dim")
  uses_mise=1
else
  npm_command=(npm)
  dim_command=("$staged_installer/node_modules/.bin/dim")
  uses_mise=0
fi
"${npm_command[@]}" install --prefix "$staged_installer" --no-save --no-fund --no-audit "${installer_tarballs[0]}"

"${dim_command[@]}" installer install core --local-packages "$package_root" --no-local-bin --defer-controller-restart
if [[ "$uses_mise" -eq 0 ]]; then
  npm install --global --prefix "$install_prefix" "${installer_tarballs[0]}"
  dim_command=("$install_prefix/bin/dim")
fi
"${dim_command[@]}" installer enable-plugin "${plugins[@]}"
"${dim_command[@]}" controller restart
echo "Installed the local DIM build and enabled its DNS, External URLs, and host mirror plugins"
