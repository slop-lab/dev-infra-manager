#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/install-source-build.bash" >&2
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
test "${#installer_tarballs[@]}" -eq 1 && test -f "${installer_tarballs[0]}"
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
"${dim_command[@]}" install-cli --local-packages "$package_root" --no-local-bin

"${dim_command[@]}" enable-plugin \
  @slop-lab/dim-plugin-dns-cloudflare \
  @slop-lab/dim-plugin-external-urls

validate_preparation
echo "[host] local package bundle installed; restart separately with just restart-controller"
"${dim_command[@]}" --version
