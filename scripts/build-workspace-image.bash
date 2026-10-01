#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Usage: bash scripts/build-workspace-image.bash" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${DIM_LOCAL_SOURCE_ROOT:?DIM_LOCAL_SOURCE_ROOT is required}"
if [[ ! -d "$source_root" || -L "$source_root" ]]; then
  echo "local image source must be a non-symlink directory: $source_root" >&2
  exit 1
fi
image_build_ref="${DIM_LOCAL_IMAGE_BUILD_REF:?DIM_LOCAL_IMAGE_BUILD_REF is required}"

docker buildx version >/dev/null

echo "[host] build trusted workspace image"
docker buildx build \
  --quiet \
  --load \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag "$image_build_ref" \
  --file "$source_root/core/images/project-workspace/Dockerfile" \
  "$source_root" >/dev/null
