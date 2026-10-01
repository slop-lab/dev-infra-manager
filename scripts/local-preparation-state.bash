#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/local-preparation-state.bash" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="${DIM_LOCAL_PACKAGE_ROOT:-$repo_root/.local/dim-packages}"
image_inspect_ref="${DIM_LOCAL_IMAGE_INSPECT_REF:?DIM_LOCAL_IMAGE_INSPECT_REF is required}"
image_record_ref="${DIM_LOCAL_IMAGE_RECORD_REF:?DIM_LOCAL_IMAGE_RECORD_REF is required}"

if [[ ! -d "$package_root" || -L "$package_root" ]]; then
  echo "prepared package path must be a non-symlink directory: $package_root" >&2
  exit 1
fi
if [[ ! -f "$package_root/packages.json" || -L "$package_root/packages.json" ]]; then
  echo "prepared package manifest must be a regular non-symlink file" >&2
  exit 1
fi
if [[ ! -f "$package_root/.dim-source-state" || -L "$package_root/.dim-source-state" ]]; then
  echo "prepared source state must be a regular non-symlink file" >&2
  exit 1
fi
shopt -s nullglob
package_tarballs=("$package_root"/*.tgz)
if [[ "${#package_tarballs[@]}" -eq 0 ]]; then
  echo "prepared package bundle contains no tarballs" >&2
  exit 1
fi
for tarball in "${package_tarballs[@]}"; do
  if [[ ! -f "$tarball" || -L "$tarball" ]]; then
    echo "prepared package tarball must be a regular non-symlink file: $tarball" >&2
    exit 1
  fi
done

printf 'schema=1\n'
cat -- "$package_root/.dim-source-state"

package_sha="$({
  cd -- "$package_root"
  LC_ALL=C sha256sum -- packages.json ./*.tgz
} | sha256sum | cut -d ' ' -f 1)"
[[ "$package_sha" =~ ^[0-9a-f]{64}$ ]]
printf 'packages.sha256=%s\n' "$package_sha"

image_id="$(docker image inspect --format '{{.Id}}' "$image_inspect_ref")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
printf 'image.ref=%s\n' "$image_record_ref"
printf 'image.id=%s\n' "$image_id"
