#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="${DIM_QEMU_TRUSTED_LAUNCHER:-$repository_root/project/.dim/qemu-verify.bash}"

test -r "$launcher" || {
  echo "protected QEMU verification launcher is not readable: $launcher" >&2
  exit 2
}

export DIM_QEMU_SOURCE_ROOT="${DIM_QEMU_SOURCE_ROOT:-$repository_root}"
exec bash "$launcher" --agent-control "$@"
