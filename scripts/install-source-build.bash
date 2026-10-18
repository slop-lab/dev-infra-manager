#!/usr/bin/env bash
set -euo pipefail

with_managed=0
if [[ "$#" -eq 1 && "$1" == --with-managed ]]; then
  with_managed=1
elif [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/install-source-build.bash [--with-managed]" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
local_root="$repo_root/.local"
package_root="$repo_root/.local/dim-packages"
readiness_file="$repo_root/.local/prepared-local.state"
lock_file="$local_root/prepare-install.lock"

command -v flock >/dev/null 2>&1 || {
  echo "install-local requires flock" >&2
  exit 1
}

mkdir -p "$local_root"
for path in "$local_root" "$package_root" "$readiness_file" "$lock_file"; do
  if [[ -L "$path" ]]; then
    echo "refusing symlinked local installation path: $path" >&2
    exit 1
  fi
done
exec 9>"$lock_file"
flock --exclusive 9
test -r "$readiness_file" || {
  echo "local source build is not prepared; run just prepare-local" >&2
  exit 1
}
package_version="$(bash "$repo_root/scripts/local-package-version.bash" "$package_root")"
image_ref="dev-infra-project-workspace:$package_version"

validate_preparation() {
  test -r "$readiness_file" || {
    echo "local source build is not prepared; run just prepare-local" >&2
    exit 1
  }
  current_state="$(
    DIM_LOCAL_PACKAGE_ROOT="$package_root" \
    DIM_LOCAL_IMAGE_INSPECT_REF="$image_ref" \
    DIM_LOCAL_IMAGE_RECORD_REF="$image_ref" \
      bash "$repo_root/scripts/local-preparation-state.bash"
  )"
  test "$(<"$readiness_file")" = "$current_state" || {
    echo "local source build provenance is stale or mismatched; run just prepare-local" >&2
    exit 1
  }
}

validate_preparation

installer_tarballs=("$package_root"/slop-lab-dim-installer-*.tgz)
test "${#installer_tarballs[@]}" -eq 1 && test -f "${installer_tarballs[0]}" && test ! -L "${installer_tarballs[0]}"
staged_installer="$(mktemp -d "${TMPDIR:-/tmp}/dim-target-installer.XXXXXX")"
cleanup() {
  find "$staged_installer" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

if command -v mise >/dev/null 2>&1; then
  npm_command=(mise exec -- npm)
  dim_command=(mise exec -- "$staged_installer/node_modules/.bin/dim")
else
  npm_command=(npm)
  dim_command=("$staged_installer/node_modules/.bin/dim")
fi
"${npm_command[@]}" install --prefix "$staged_installer" --no-save --no-fund --no-audit "${installer_tarballs[0]}"

echo "[host] install package bundle"
core_options=(--local-packages "$package_root" --no-local-bin)
if [[ "$with_managed" -eq 1 ]]; then
  core_options+=(--with-managed --defer-controller-restart)
fi
"${dim_command[@]}" installer install core "${core_options[@]}"

if [[ "$with_managed" -eq 1 ]]; then
  plugin_archives=()
  for plugin in dns-cloudflare external-urls host-mirrors; do
    matches=("$package_root"/slop-lab-dim-plugin-"$plugin"-*.tgz)
    [[ "${#matches[@]}" -eq 1 && -f "${matches[0]}" && ! -L "${matches[0]}" ]] || {
      echo "prepared bundle must contain one regular $plugin plugin archive" >&2
      exit 1
    }
    plugin_archives+=("${matches[0]}")
  done
  "${dim_command[@]}" installer install plugin "${plugin_archives[@]}"
  "${dim_command[@]}" controller restart
fi

validate_preparation
echo "[host] local package bundle installed"
if [[ "$with_managed" -eq 1 ]]; then echo "[host] managed controller activated with DNS, External URLs and host mirror plugins"; fi
"${dim_command[@]}" --version
