# Private fixture context shared by its separate preparation and serving phases.
examples_control_plane_environment() {
  local trial="$1"
  [[ "$trial" == /* && -d "$trial" && ! -L "$trial" && "$(stat -Lc '%u:%a' "$trial")" == "$(id -u):700" ]] || {
    printf '%s\n' 'control-plane runtime must be a caller-owned private directory' >&2; return 2;
  }
  : "${DIM_EXAMPLE_PACKAGE_BUNDLE:?exact source package bundle required}"
  [[ "${DIM_PRACTICAL_CI_REQUIRED:-0}" =~ ^[01]$ ]] || return 2
  export npm_config_cache="$trial/npm-cache" npm_config_userconfig=/dev/null npm_config_ignore_scripts=true
  export DIM_EXAMPLE_DIM_BIN="$trial/facade/node_modules/.bin/dim"
  export XDG_CONFIG_HOME="$trial/config" XDG_DATA_HOME="$trial/data" XDG_STATE_HOME="$trial/state" XDG_RUNTIME_DIR="$trial/run"
  export DIM_CONFIG_PATH="$trial/config/dim.json" DIM_DATA_HOME="$trial/data/dim" DIM_STATE_ROOT="$trial/state/dim"
}

examples_control_plane_binding() {
  local digest result
  result="$(sha256sum -- "$DIM_EXAMPLE_PACKAGE_BUNDLE/packages.json")" || return "$?"
  digest="${result%% *}"
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 2
  printf '%s:%s\n' "$digest" "${DIM_PRACTICAL_CI_REQUIRED:-0}"
}
