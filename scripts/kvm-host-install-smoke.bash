#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="${DIM_QEMU_TRUSTED_LAUNCHER:-$repository_root/project/.dim/qemu-verify.bash}"

if [[ ! -r "$launcher" ]]; then
  echo "protected QEMU verification launcher is not readable: $launcher" >&2
  echo "assemble the root repository at $repository_root/project or set DIM_QEMU_TRUSTED_LAUNCHER" >&2
  exit 2
fi

export DIM_QEMU_SOURCE_ROOT="${DIM_QEMU_SOURCE_ROOT:-$repository_root}"
exec bash "$launcher" "$@"
