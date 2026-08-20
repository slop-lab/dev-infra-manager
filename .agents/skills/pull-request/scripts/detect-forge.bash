#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=forge-common.bash
source "$script_dir/forge-common.bash"

remote=origin
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --remote) remote="${2:?--remote requires a value}"; shift 2 ;;
    *) echo "usage: detect-forge.bash [--remote REMOTE]" >&2; exit 2 ;;
  esac
done

forge_resolve "$remote"
forge_print_identity
[[ "$forge_provider" != unknown ]] || exit 3
