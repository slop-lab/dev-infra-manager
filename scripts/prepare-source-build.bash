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
rollback_image_ref="dev-infra-project-workspace:rollback-$(id -u)-$$"

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
previous_readiness="$stage_root/previous-readiness"
previous_packages_saved=0
packages_promoted=0
previous_readiness_saved=0
readiness_promoted=0
previous_image_saved=0
image_publication_attempted=0
temporary_image_id=""
previous_image_id=""
published=0

cleanup() {
  status="$?"
  trap - EXIT
  rollback_failed=0
  if [[ "$published" -eq 0 ]]; then
    if [[ "$readiness_promoted" -eq 1 ]]; then
      if ! mv -- "$readiness_file" "$stage_root/failed-readiness"; then
        echo "failed to preserve unpublished readiness at $stage_root/failed-readiness" >&2
        rollback_failed=1
      fi
    fi
    if [[ "$previous_readiness_saved" -eq 1 ]]; then
      if [[ -e "$readiness_file" ]]; then
        echo "refusing to overwrite readiness while restoring $previous_readiness" >&2
        rollback_failed=1
      elif ! mv -- "$previous_readiness" "$readiness_file"; then
        echo "failed to restore readiness from $previous_readiness" >&2
        rollback_failed=1
      fi
    fi
    if [[ "$packages_promoted" -eq 1 ]]; then
      if ! mv -- "$package_root" "$stage_root/failed-packages"; then
        echo "failed to preserve unpublished packages at $stage_root/failed-packages" >&2
        rollback_failed=1
      fi
    fi
    if [[ "$previous_packages_saved" -eq 1 ]]; then
      if [[ -e "$package_root" ]]; then
        echo "refusing to overwrite packages while restoring $previous_packages" >&2
        rollback_failed=1
      elif ! mv -- "$previous_packages" "$package_root"; then
        echo "failed to restore packages from $previous_packages" >&2
        rollback_failed=1
      fi
    fi
    if [[ "$image_publication_attempted" -eq 1 ]]; then
      echo "image publication requires manual recovery; refusing to mutate $final_image_ref" >&2
      echo "prepared image retained at $temporary_image_ref ($temporary_image_id)" >&2
      if [[ "$previous_image_saved" -eq 1 ]]; then
        echo "previous image retained at $rollback_image_ref ($previous_image_id)" >&2
      fi
      rollback_failed=1
    fi
  fi
  if [[ "$image_publication_attempted" -eq 0 || "$published" -eq 1 ]]; then
    if [[ -n "$temporary_image_id" ]]; then
      if ! current_temporary_image_id="$(docker image inspect --format '{{.Id}}' "$temporary_image_ref" 2>/dev/null)"; then
        echo "failed to verify temporary image ownership for $temporary_image_ref" >&2
        rollback_failed=1
      elif [[ "$current_temporary_image_id" != "$temporary_image_id" ]]; then
        echo "refusing to remove changed temporary image $temporary_image_ref" >&2
        rollback_failed=1
      elif ! docker image rm "$temporary_image_ref" >/dev/null; then
        echo "failed to remove temporary image $temporary_image_ref" >&2
        rollback_failed=1
      fi
    fi
    if [[ "$previous_image_saved" -eq 1 ]]; then
      if ! current_rollback_image_id="$(docker image inspect --format '{{.Id}}' "$rollback_image_ref" 2>/dev/null)"; then
        echo "failed to verify rollback image ownership for $rollback_image_ref" >&2
        rollback_failed=1
      elif [[ "$current_rollback_image_id" != "$previous_image_id" ]]; then
        echo "refusing to remove changed rollback image $rollback_image_ref" >&2
        rollback_failed=1
      elif ! docker image rm "$rollback_image_ref" >/dev/null; then
        echo "failed to remove rollback image $rollback_image_ref" >&2
        rollback_failed=1
      fi
    fi
  fi
  if [[ "$rollback_failed" -eq 1 ]]; then
    echo "rollback incomplete; recovery data retained at $stage_root" >&2
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  else
    if ! rm -rf -- "$stage_root"; then
      echo "failed to remove completed staging path $stage_root" >&2
      if [[ "$status" -eq 0 ]]; then
        status=1
      fi
    fi
  fi
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
if [[ -d "$package_root" ]]; then
  mv -- "$package_root" "$previous_packages"
  previous_packages_saved=1
fi
mv -- "$package_stage" "$package_root"
packages_promoted=1
if [[ -f "$readiness_file" ]]; then
  mv -- "$readiness_file" "$previous_readiness"
  previous_readiness_saved=1
fi
mv -- "$readiness_stage" "$readiness_file"
readiness_promoted=1

if previous_image_id="$(docker image inspect --format '{{.Id}}' "$final_image_ref" 2>/dev/null)"; then
  docker image tag "$final_image_ref" "$rollback_image_ref"
  previous_image_saved=1
fi
image_publication_attempted=1
docker image tag "$temporary_image_ref" "$final_image_ref"
final_image_id="$(docker image inspect --format '{{.Id}}' "$final_image_ref")"
if [[ "$final_image_id" != "$temporary_image_id" ]]; then
  echo "promoted image ID does not match the prepared image" >&2
  exit 1
fi
published=1

echo "[host] local source build is prepared"
