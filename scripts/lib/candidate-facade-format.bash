#!/usr/bin/env bash

format_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pins_helper="${pins_helper:-$format_dir/bootstrap-ubuntu-pins.bash}"
source "$pins_helper"
dim_pinned_node="$dim_node_root/bin/node"
dim_pinned_tools="$dim_source_tools_root/bin"
dim_system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

dim_candidate_facade_content() {
  local candidate_root="$1"
  printf '#!/usr/bin/env bash\n'
  printf 'PATH=%q\n' "${dim_pinned_node%/*}:$dim_pinned_tools:$dim_system_path"
  printf 'export PATH\n'
  printf 'exec %q "$@"\n' "$candidate_root/node_modules/.bin/dim"
}
