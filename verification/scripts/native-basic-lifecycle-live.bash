#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
sentinel_root="$(mktemp -d /tmp/dim-native-basic-lifecycle.XXXXXXXX)"
chmod 0700 "$sentinel_root"
sentinel_root_identity="$(stat -Lc '%d:%i' -- "$sentinel_root")"
cleanup_sentinel="$sentinel_root/cleanup-uncertain"

cleanup() {
  local status=$? cleanup_status=0 current_identity=""
  trap - EXIT INT TERM
  set +e
  if [[ -d "$sentinel_root" && ! -L "$sentinel_root" ]]; then
    current_identity="$(stat -Lc '%d:%i' -- "$sentinel_root" 2>/dev/null)"
  fi
  if [[ "$current_identity" == "$sentinel_root_identity" ]]; then
    rm -rf -- "$sentinel_root" || cleanup_status=1
  else
    cleanup_status=1
  fi
  if ((cleanup_status != 0)); then
    printf 'native-basic-lifecycle: private sentinel cleanup is uncertain\n' >&2
    exit 125
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set +e
DIM_NATIVE_BASIC_LIFECYCLE_CLEANUP_SENTINEL="$cleanup_sentinel" \
  pnpm --dir "$repo_root/verification" exec vitest run \
    --config live/vitest.config.ts live/nativeBasicLifecycleLive.test.ts
status=$?
set -e

if [[ -e "$cleanup_sentinel" || -L "$cleanup_sentinel" ]]; then
  status=125
fi
exit "$status"
