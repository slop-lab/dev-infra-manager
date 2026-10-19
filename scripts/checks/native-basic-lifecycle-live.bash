#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
image="dim-native-workspace-smoke:$(id -u)-$$"
cleanup() { docker image rm "$image" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The optional composition's dependency graph builds core, native Git and the
# workflow compiler before managed. Runtime resources and service state are
# created only in the disposable integration fixture.
pnpm --dir "$repo_root" --filter '@slop-lab/dim-host-plugin-native-git...' --filter '@slop-lab/dim-control-plane-admin...' --workspace-concurrency=1 --recursive run build
DIM_LOCAL_SOURCE_ROOT="$repo_root" DIM_LOCAL_IMAGE_BUILD_REF="$image" \
  bash "$repo_root/scripts/build-workspace-image.bash"
node "$repo_root/scripts/checks/native-workspace-smoke.mts" "$image"
