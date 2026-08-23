#!/usr/bin/env bash

readonly -a DIM_RUNTIME_BACKENDS=(sysbox gvisor rootless-podman runc)

dim_is_runtime_backend() {
  local candidate="$1"
  local backend
  for backend in "${DIM_RUNTIME_BACKENDS[@]}"; do
    [[ "$candidate" != "$backend" ]] || return 0
  done
  return 1
}

dim_runtime_backend_choices() {
  local IFS='|'
  echo "${DIM_RUNTIME_BACKENDS[*]}"
}
