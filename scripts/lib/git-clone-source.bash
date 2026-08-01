#!/usr/bin/env bash

# Selects a repository containing the current checkout, including tracked
# worktree changes and non-ignored untracked files. Recreate it as a single
# root commit when the checkout is dirty or shallow. The caller owns
# snapshot_dir and its cleanup.
dim_prepare_clone_source() {
  local source_repo="$1"
  local snapshot_dir="$2"
  local dirty_policy="${3:-use}"
  local snapshot_tree="HEAD"
  local snapshot_commit
  local -a untracked_files=()

  case "$dirty_policy" in
    use|discard|auto) ;;
    *)
      echo "dirty repository policy must be use, discard, or auto" >&2
      return 2
      ;;
  esac

  mapfile -d '' untracked_files \
    < <(git -C "$source_repo" ls-files --others --exclude-standard -z)

  local dirty=false
  if ! git -C "$source_repo" diff --quiet HEAD -- ||
    [[ "${#untracked_files[@]}" -gt 0 ]]; then
    dirty=true
  fi
  if [[ "$dirty_policy" == auto && "$dirty" == true ]]; then
    echo "repository is dirty; pass --dirty-repo use or discard explicitly" >&2
    return 2
  fi
  if [[ "$dirty_policy" == use ]] &&
    ! git -C "$source_repo" diff --quiet HEAD --; then
    snapshot_commit="$(git -C "$source_repo" stash create "DIM worktree snapshot")"
    snapshot_tree="$snapshot_commit"
  fi

  if [[ "$snapshot_tree" == "HEAD" ]] &&
    [[ "$dirty" == false ]] &&
    [[ "$(git -C "$source_repo" rev-parse --is-shallow-repository)" != "true" ]]; then
    DIM_GIT_CLONE_SOURCE="$source_repo"
    return
  fi

  mkdir -p "$snapshot_dir"
  git -C "$source_repo" archive "$snapshot_tree" | tar -x -C "$snapshot_dir"
  if [[ "$dirty_policy" == use && "${#untracked_files[@]}" -gt 0 ]]; then
    printf '%s\0' "${untracked_files[@]}" |
      tar -C "$source_repo" --null --files-from=- -cf - |
      tar -x -C "$snapshot_dir"
  fi
  git -C "$snapshot_dir" init --initial-branch=main >/dev/null
  git -C "$snapshot_dir" add .
  git -C "$snapshot_dir" \
    -c user.name="DIM Snapshot" \
    -c user.email="snapshot@dim.invalid" \
    commit -m "snapshot current worktree" >/dev/null
  DIM_GIT_CLONE_SOURCE="$snapshot_dir"
}
