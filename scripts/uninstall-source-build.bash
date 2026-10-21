#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
local_root="$repo_root/.local"
lock_file="$local_root/prepare-install.lock"
for path in "$local_root" "$lock_file"; do
  [[ ! -L "$path" ]] || { echo "refusing symlinked local removal path: $path" >&2; exit 1; }
done
mkdir -p "$local_root"
exec 9>"$lock_file"
flock --exclusive 9
node "$repo_root/scripts/uninstall-local.ts" "$@"
