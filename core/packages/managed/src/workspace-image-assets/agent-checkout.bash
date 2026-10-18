#!/usr/bin/env bash
set -euo pipefail

: "${DIM_AGENT_REPOSITORY_URL:?}"
: "${DIM_AGENT_ROOT_COMMIT:?}"
: "${DIM_AGENT_WORKSPACE_ID:?}"

if [[ ! -d .git ]]; then
  stage_digest="$(printf '%s\0%s\0%s' "$DIM_AGENT_WORKSPACE_ID" "$DIM_AGENT_ROOT_COMMIT" "$DIM_AGENT_REPOSITORY_URL" | sha256sum)"
  stage=".dim-checkout.${stage_digest%% *}"
  shopt -s dotglob nullglob
  if [[ ! -f "$stage/.git/dim-publish-ready" ]]; then
    for path in ./*; do
      [[ "$path" == "./$stage" ]] || {
        echo "recommended checkout volume is populated without a Git repository" >&2
        exit 1
      }
    done
    [[ ! -d "$stage" ]] || rm -rf -- "$stage"
  fi
  if [[ ! -d "$stage" ]]; then
    mkdir -- "$stage"
    trap 'rm -rf -- "$stage"' EXIT
    git -C "$stage" init
    git -C "$stage" remote add origin "$DIM_AGENT_REPOSITORY_URL"
    git -C "$stage" fetch --no-tags origin "$DIM_AGENT_ROOT_COMMIT"
    git -C "$stage" checkout -b workspace FETCH_HEAD
    printf '%s\n' "$DIM_AGENT_WORKSPACE_ID" > "$stage/.git/dim-workspace-id"
    printf '%s\n' "$DIM_AGENT_ROOT_COMMIT" > "$stage/.git/dim-root-commit"
    : > "$stage/.git/dim-publish-manifest"
    for path in "$stage"/*; do
      [[ "${path##*/}" == ".git" ]] || printf '%s\0' "${path##*/}" >> "$stage/.git/dim-publish-manifest"
    done
    : > "$stage/.git/dim-publish-ready"
    trap - EXIT
  fi
  [[ "$(cat "$stage/.git/dim-workspace-id" 2>/dev/null)" == "$DIM_AGENT_WORKSPACE_ID"
    && "$(cat "$stage/.git/dim-root-commit" 2>/dev/null)" == "$DIM_AGENT_ROOT_COMMIT"
    && "$(git -C "$stage" remote get-url origin)" == "$DIM_AGENT_REPOSITORY_URL" ]] || {
    echo "recommended checkout initial publication ownership changed" >&2
    exit 1
  }
  declare -A expected=()
  while IFS= read -r -d '' entry; do expected["$entry"]=1; done < "$stage/.git/dim-publish-manifest"
  for path in ./*; do
    entry="${path##*/}"
    [[ "$entry" == "$stage" || -n "${expected[$entry]+present}" ]] || {
      echo "recommended checkout changed during initial publication; preserving its data" >&2
      exit 1
    }
  done
  while IFS= read -r -d '' entry; do
    source="$stage/$entry"
    if [[ -e "$source" || -L "$source" ]]; then
      mv -T --no-clobber -- "$source" "./$entry"
      [[ ! -e "$source" && ! -L "$source" ]] || {
        echo "recommended checkout changed during initial publication; preserving its data" >&2
        exit 1
      }
    fi
  done < "$stage/.git/dim-publish-manifest"
  mv -T --no-clobber -- "$stage/.git" ./.git
  [[ ! -d "$stage/.git" ]] || {
    echo "recommended checkout changed during initial publication; preserving its data" >&2
    exit 1
  }
  rmdir -- "$stage"
else
  [[ "$(cat .git/dim-workspace-id 2>/dev/null)" == "$DIM_AGENT_WORKSPACE_ID" ]] || {
    echo "recommended checkout belongs to another workspace identity" >&2
    exit 1
  }
  [[ "$(git remote get-url origin)" == "$DIM_AGENT_REPOSITORY_URL" ]] || {
    echo "recommended checkout origin changed" >&2
    exit 1
  }
  current_root="$(cat .git/dim-root-commit 2>/dev/null)" || {
    echo "recommended checkout has no recorded protected root; preserve its data and recreate the workspace" >&2
    exit 1
  }
  if [[ "$current_root" != "$DIM_AGENT_ROOT_COMMIT" ]]; then
    echo "retained checkout remains at its original protected root; run git fetch and merge or rebase explicitly to adopt reviewed changes" >&2
  fi
fi
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git config remote.origin.push "HEAD:refs/heads/proposals/$DIM_AGENT_WORKSPACE_ID/workspace"
