#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -gt 1 || ( "$#" -eq 1 && "$1" != --with-managed ) ]]; then
  echo "Usage: just reinstall-local [--with-managed]" >&2
  exit 2
fi
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Validate the candidate before destroying the currently usable installation.
bash "$repo_root/scripts/install-source-build.bash" --check
bash "$repo_root/scripts/uninstall-source-build.bash" --yes
bash "$repo_root/scripts/install-source-build.bash" "$@"
