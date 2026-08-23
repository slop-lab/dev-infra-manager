#!/usr/bin/env bash

# Requires verification/scripts/lib/local-npm-registry.bash to be sourced by the caller.
dim_install_example_cli() {
  local repo_root="$1"
  local work_dir="$2"
  local install_prefix="$3"

  bash "$repo_root/verification/scripts/pack-local-packages.bash" "$work_dir" >/dev/null
  dim_start_local_npm_registry "$work_dir"
  dim_publish_to_local_registry \
    "$work_dir"/*dim-core*.tgz \
    "$work_dir"/*dim-contracts-external-url*.tgz \
    "$work_dir"/*plugin-dns-cloudflare*.tgz \
    "$work_dir"/*dim-cli*.tgz \
    "$work_dir"/*dim-installer*.tgz
  mkdir -p "$install_prefix"
  npm install --global --prefix "$install_prefix" \
    "$work_dir"/*dim-installer*.tgz --silent >/dev/null
  DIM_EXAMPLE_DIM_BIN="$install_prefix/bin/dim"
  "$DIM_EXAMPLE_DIM_BIN" install-cli --no-local-bin >/dev/null
}
