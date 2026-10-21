#!/usr/bin/env bash
set -euo pipefail
install_options=()
remove_options=(--yes)
for option in "$@"; do
  case "$option" in
    --with-managed) install_options+=("$option") ;;
    --keep-cache-data) remove_options+=("$option") ;;
    *) echo "Usage: just reinstall-local [--with-managed] [--keep-cache-data]" >&2; exit 2 ;;
  esac
done
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Validate the candidate before destroying the currently usable installation.
bash "$repo_root/scripts/install-source-build.bash" --check
bash "$repo_root/scripts/uninstall-source-build.bash" "${remove_options[@]}"
bash "$repo_root/scripts/install-source-build.bash" "${install_options[@]}"
