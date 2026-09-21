#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/prepare-source-build.bash" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
local_root="$repo_root/.local"
package_root="$local_root/dim-packages"
readiness_file="$local_root/prepared-local.state"
readiness_tmp="$readiness_file.tmp.$$"
lock_file="$local_root/prepare-install.lock"
temporary_image_ref="dev-infra-project-workspace:prepare-$(id -u)-$$"
promoted=0

command -v flock >/dev/null 2>&1 || {
  echo "prepare-local requires flock" >&2
  exit 1
}

mkdir -p "$local_root"
exec 9>"$lock_file"
flock --exclusive 9

cleanup() {
  status="$?"
  rm -f -- "$readiness_tmp"
  if [[ "$promoted" -eq 0 ]]; then
    rm -f -- "$readiness_file"
  fi
  docker image rm "$temporary_image_ref" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$package_root"
rm -f -- "$readiness_file" "$readiness_tmp"

find "$package_root" -mindepth 1 -depth -delete
bash "$repo_root/scripts/pack-source-build.bash" "$package_root"
package_version="$(bash "$repo_root/scripts/local-package-version.bash" "$package_root")"
final_image_ref="dev-infra-project-workspace:$package_version"
DIM_LOCAL_IMAGE_BUILD_REF="$temporary_image_ref" \
  bash "$repo_root/scripts/build-workspace-image.bash"
DIM_LOCAL_IMAGE_INSPECT_REF="$temporary_image_ref" \
DIM_LOCAL_IMAGE_RECORD_REF="$final_image_ref" \
  bash "$repo_root/scripts/local-preparation-state.bash" >"$readiness_tmp"
mv -- "$readiness_tmp" "$readiness_file"
docker image tag "$temporary_image_ref" "$final_image_ref"
promoted=1

echo "[host] local source build is prepared"
