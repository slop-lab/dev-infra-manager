#!/usr/bin/env bash
set -euo pipefail

inner_image="${DIM_CONTAINER_TEST_IMAGE:-alpine:3.22}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
workspace_image="dev-infra-project-workspace:$(node -p "require('./core/package.json').version")"

run_inner_smoke() {
  local outer_image="$1"
  local expected_driver="$2"
  shift 2

  docker run --rm --privileged --runtime runc "$@" "$outer_image" bash -lc "
    test \"\\\$(docker info --format '{{.Driver}}')\" = '$expected_driver'
    docker run --rm '$inner_image' sh -c \
      'wget -qO- https://example.com >/dev/null && echo inner-docker-network-ok'
  "
}

run_inner_smoke "$workspace_image" overlayfs

echo "container-inner-docker-smoke-ok"
