#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/runtime-backends.bash
source "$script_dir/lib/runtime-backends.bash"

backend="${1:-}"
if ! dim_is_runtime_backend "$backend"; then
  echo "usage: $0 <$(dim_runtime_backend_choices)>" >&2
  exit 2
fi

config_path="${DIM_CONFIG_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/slop-lab/dim.json}"
config_dir="$(dirname -- "$config_path")"
mkdir -p "$config_dir"
temporary="$(mktemp "$config_dir/dim.json.tmp.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

if [[ -f "$config_path" ]]; then
  jq --arg backend "$backend" \
    'if .schemaVersion != 1 then error("invalid DIM user config schema") else . + {workspaceBackend: $backend} end' \
    "$config_path" >"$temporary"
else
  jq -n --arg backend "$backend" \
    '{schemaVersion: 1, workspaceBackend: $backend}' >"$temporary"
fi
chmod 0600 "$temporary"
mv -f -- "$temporary" "$config_path"
trap - EXIT
