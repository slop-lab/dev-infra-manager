#!/usr/bin/env bash
set -euo pipefail

with_managed=0
if [[ "$#" -eq 1 && "$1" == --with-managed ]]; then
  with_managed=1
elif [[ "$#" -ne 0 ]]; then
  echo "Usage: bash verification/scripts/install-dim-local.bash [--with-managed]" >&2
  exit 2
fi

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

core_options=(--local-packages "$package_root" --no-local-bin)
if [[ "$with_managed" -eq 1 ]]; then core_options+=(--with-managed --defer-controller-restart); fi
"${dim_command[@]}" installer install core "${core_options[@]}"
if [[ "$uses_mise" -eq 0 ]]; then
  npm install --global --prefix "$install_prefix" "${installer_tarballs[0]}"
  dim_command=("$install_prefix/bin/dim")
fi
if [[ "$with_managed" -eq 1 ]]; then
  plugin_archives=()
  for plugin in dns-cloudflare external-urls host-mirrors; do
    matches=("$package_root"/slop-lab-dim-plugin-"$plugin"-*.tgz)
    [[ "${#matches[@]}" -eq 1 && -f "${matches[0]}" && ! -L "${matches[0]}" ]] || {
      echo "local bundle must contain one regular $plugin plugin archive" >&2
      exit 1
    }
    plugin_archives+=("${matches[0]}")
  done
  "${dim_command[@]}" installer install plugin "${plugin_archives[@]}"
  "${dim_command[@]}" controller restart
fi
echo "Installed the local DIM CLI"
