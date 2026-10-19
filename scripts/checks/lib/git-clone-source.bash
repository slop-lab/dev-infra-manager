#!/usr/bin/env bash

# Selects a repository containing the current checkout, including tracked
# worktree changes and non-ignored untracked files. Recreate it as a single
# root commit when the checkout is dirty or shallow. The caller owns
# snapshot_dir and its cleanup.
dim_prepare_clone_source() {
  local source_repo
  source_repo="$(git -C "$1" rev-parse --show-toplevel)"
  local snapshot_dir="$2"
  local dirty_policy="${3:-use}"
  local excluded_path="${4:-}"
  local snapshot_tree="HEAD"
  local snapshot_commit
  local -a pathspec=(.)
  local -a untracked_files=()

  if [[ -n "$excluded_path" ]]; then
    pathspec+=(":(exclude)$excluded_path" ":(exclude)$excluded_path/**")
  fi

  case "$dirty_policy" in
    use|discard|auto) ;;
    *)
      echo "dirty repository policy must be use, discard, or auto" >&2
      return 2
      ;;
  esac

  mapfile -d '' untracked_files \
    < <(git -C "$source_repo" ls-files --others --exclude-standard -z -- "${pathspec[@]}")

  local dirty=false
  if ! git -C "$source_repo" diff --quiet HEAD -- "${pathspec[@]}" ||
    [[ "${#untracked_files[@]}" -gt 0 ]]; then
    dirty=true
  fi
  if [[ "$dirty_policy" == auto && "$dirty" == true ]]; then
    echo "repository is dirty; pass --dirty-repo use or discard explicitly" >&2
    return 2
  fi
  if [[ "$dirty_policy" == use ]] &&
    ! git -C "$source_repo" diff --quiet HEAD -- "${pathspec[@]}"; then
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
    local untracked_file
    for untracked_file in "${untracked_files[@]}"; do
      mkdir -p "$snapshot_dir/$(dirname -- "$untracked_file")"
      cp -a "$source_repo/$untracked_file" "$snapshot_dir/$untracked_file"
    done
  fi
  git -C "$snapshot_dir" init --initial-branch=main >/dev/null
  git -C "$snapshot_dir" add .
  git -C "$snapshot_dir" \
    -c user.name="DIM Snapshot" \
    -c user.email="snapshot@dim.invalid" \
    commit -m "snapshot current worktree" >/dev/null
  DIM_GIT_CLONE_SOURCE="$snapshot_dir"
}

dim_prepare_workbench_clone_source() {
  local checkout_root
  checkout_root="$(git -C "$1" rev-parse --show-toplevel)"
  local snapshot_dir="$2"
  local dirty_policy="${3:-use}"
  local project_source=""

  mkdir -p "$snapshot_dir/workbench" "$snapshot_dir/.snapshots"
  if [[ -e "$checkout_root/project/.git" ]]; then
    project_source="$(git -C "$checkout_root/project" rev-parse --show-toplevel)"
  fi

  dim_prepare_clone_source \
    "$checkout_root" "$snapshot_dir/.snapshots/root" "$dirty_policy" \
    "${project_source:+project}"
  git -C "$DIM_GIT_CLONE_SOURCE" archive HEAD | tar -x -C "$snapshot_dir/workbench"

  if [[ -n "$project_source" ]]; then
    rm -rf -- "$snapshot_dir/workbench/project"
    mkdir -p "$snapshot_dir/workbench/project"
    dim_prepare_clone_source \
      "$project_source" "$snapshot_dir/.snapshots/project" "$dirty_policy"
    git -C "$DIM_GIT_CLONE_SOURCE" archive HEAD | tar -x -C "$snapshot_dir/workbench/project"
  fi
  find "$snapshot_dir/.snapshots" -depth -delete
  git -C "$snapshot_dir" init --initial-branch=main >/dev/null
  git -C "$snapshot_dir" add workbench
  git -C "$snapshot_dir" \
    -c user.name="DIM Snapshot" \
    -c user.email="snapshot@dim.invalid" \
    commit -m "snapshot assembled workbench" >/dev/null
  DIM_GIT_CLONE_SOURCE="$snapshot_dir"
}
