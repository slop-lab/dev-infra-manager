#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$#" -eq 1 && ( "$1" == --help || "$1" == -h ) ]]; then
  exec node "$repo_root/scripts/reinstall-local.ts" "$@"
fi
# Validate the candidate before asking to destroy a usable installation.
bash "$repo_root/scripts/install-source-build.bash" --check
exec node "$repo_root/scripts/reinstall-local.ts" "$@"
