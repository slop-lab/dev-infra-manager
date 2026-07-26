#!/usr/bin/env bash

# Selects a repository that can be cloned without depending on omitted parents.
# GitHub Actions checkouts are shallow by default, so recreate HEAD as a single
# root commit when necessary. The caller owns snapshot_dir and its cleanup.
dim_prepare_clone_source() {
  local source_repo="$1"
  local snapshot_dir="$2"

  if [[ "$(git -C "$source_repo" rev-parse --is-shallow-repository)" != "true" ]]; then
    DIM_GIT_CLONE_SOURCE="$source_repo"
    return
  fi

  mkdir -p "$snapshot_dir"
  git -C "$source_repo" archive HEAD | tar -x -C "$snapshot_dir"
  git -C "$snapshot_dir" init --initial-branch=main >/dev/null
  git -C "$snapshot_dir" add .
  git -C "$snapshot_dir" \
    -c user.name="DIM Snapshot" \
    -c user.email="snapshot@dim.invalid" \
    commit -m "snapshot current checkout" >/dev/null
  DIM_GIT_CLONE_SOURCE="$snapshot_dir"
}
