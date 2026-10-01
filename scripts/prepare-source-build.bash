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
lock_file="$local_root/prepare-install.lock"
temporary_image_ref="dev-infra-project-workspace:prepare-$(id -u)-$$"

command -v flock >/dev/null 2>&1 || {
  echo "prepare-local requires flock" >&2
  exit 1
}
if [[ -L "$local_root" ]]; then
  echo "refusing symlinked local build root: $local_root" >&2
  exit 1
fi
mkdir -p -- "$local_root"
if [[ ! -d "$local_root" || -L "$local_root" ]]; then
  echo "local build root must be a non-symlink directory: $local_root" >&2
  exit 1
fi
for path in "$package_root" "$readiness_file" "$lock_file"; do
  if [[ -L "$path" ]]; then
    echo "refusing symlinked local preparation path: $path" >&2
    exit 1
  fi
done
if [[ -e "$package_root" && ! -d "$package_root" ]]; then
  echo "prepared package path must be a directory: $package_root" >&2
  exit 1
fi

exec 9>"$lock_file"
flock --exclusive 9

stage_root="$(mktemp -d "$local_root/prepare.XXXXXX")"
source_stage="$stage_root/source"
package_stage="$stage_root/packages"
readiness_stage="$stage_root/readiness"
previous_packages="$stage_root/previous-packages"
package_swapped=0
published=0

cleanup() {
  status="$?"
  if [[ "$published" -eq 0 && "$package_swapped" -eq 1 ]]; then
    mv -- "$package_root" "$stage_root/failed-packages"
    if [[ -d "$previous_packages" ]]; then
      mv -- "$previous_packages" "$package_root"
    fi
  fi
  docker image rm "$temporary_image_ref" >/dev/null 2>&1 || true
  rm -rf -- "$stage_root"
  exit "$status"
}
trap cleanup EXIT

DIM_SOURCE_BUILD_ROOT="$source_stage" \
  bash "$repo_root/scripts/pack-source-build.bash" "$package_stage"
package_version="$(bash "$repo_root/scripts/local-package-version.bash" "$package_stage")"
final_image_ref="dev-infra-project-workspace:$package_version"
DIM_LOCAL_SOURCE_ROOT="$source_stage" \
DIM_LOCAL_IMAGE_BUILD_REF="$temporary_image_ref" \
  bash "$repo_root/scripts/build-workspace-image.bash"
DIM_LOCAL_PACKAGE_ROOT="$package_stage" \
DIM_LOCAL_IMAGE_INSPECT_REF="$temporary_image_ref" \
DIM_LOCAL_IMAGE_RECORD_REF="$final_image_ref" \
  bash "$repo_root/scripts/local-preparation-state.bash" >"$readiness_stage"

temporary_image_id="$(docker image inspect --format '{{.Id}}' "$temporary_image_ref")"
docker image tag "$temporary_image_ref" "$final_image_ref"
final_image_id="$(docker image inspect --format '{{.Id}}' "$final_image_ref")"
if [[ "$final_image_id" != "$temporary_image_id" ]]; then
  echo "promoted image ID does not match the prepared image" >&2
  exit 1
fi

if [[ -d "$package_root" ]]; then
  mv -- "$package_root" "$previous_packages"
fi
mv -- "$package_stage" "$package_root"
package_swapped=1
mv -- "$readiness_stage" "$readiness_file"
published=1

echo "[host] local source build is prepared"
