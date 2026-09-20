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
image_ref=dev-infra-project-workspace:latest

command -v flock >/dev/null 2>&1 || {
  echo "install-local requires flock" >&2
  exit 1
}

mkdir -p "$local_root"
exec 9>"$lock_file"
flock --exclusive 9

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

if command -v mise >/dev/null 2>&1; then
  dim_command=(mise exec -- dim)
else
  dim_command=(dim)
fi

echo "[host] install package bundle"
"${dim_command[@]}" install-cli --local-packages "$package_root" --no-local-bin

"${dim_command[@]}" enable-plugin \
  @slop-lab/dim-plugin-dns-cloudflare \
  @slop-lab/dim-plugin-external-urls

validate_preparation
echo "[host] local package bundle installed; restart separately with just restart-controller"
"${dim_command[@]}" --version
