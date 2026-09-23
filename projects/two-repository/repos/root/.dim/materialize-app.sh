#!/usr/bin/env sh
set -eu

: "${DIM_PROJECT_ROOT:?DIM_PROJECT_ROOT is required}"
: "${DIM_PROJECT_MANIFEST:?DIM_PROJECT_MANIFEST is required}"
: "${DIM_WORKSPACE_DATA:?DIM_WORKSPACE_DATA is required}"

configured_ref="$(jq -er '.repositories.app.ref | select(type == "string" and length > 0)' "$DIM_PROJECT_ROOT/.dim/repos.yml")"
case "$configured_ref" in refs/*) ref="$configured_ref" ;; *) ref="refs/heads/$configured_ref" ;; esac
git_base_url="$(jq -er '.gitBaseUrl | select(type == "string" and length > 0)' "$DIM_PROJECT_MANIFEST")"
workspace_url="$git_base_url/app.git"

app_dir="$DIM_WORKSPACE_DATA/app"
if test -d "$app_dir/.git"; then
  exit 0
fi
if test -e "$app_dir" || test -L "$app_dir"; then
  echo "app checkout path exists but is not a Git repository: $app_dir" >&2
  exit 1
fi

staging="$(mktemp -d "$DIM_WORKSPACE_DATA/.app-materialize.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT HUP INT TERM

trusted_git() {
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 \
    GIT_TERMINAL_PROMPT=0 \
    git -c core.hooksPath=/dev/null "$@"
}

trusted_git init "$staging" >/dev/null
trusted_git -C "$staging" remote add origin "$workspace_url"
trusted_git -C "$staging" fetch --no-tags origin "$ref"
commit="$(trusted_git -C "$staging" rev-parse 'FETCH_HEAD^{commit}')"
case "$ref" in
  refs/heads/*)
    branch="${ref#refs/heads/}"
    test -n "$branch"
    trusted_git -C "$staging" checkout -b "$branch" "$commit" >/dev/null
    ;;
  *)
    trusted_git -C "$staging" checkout --detach "$commit" >/dev/null
    ;;
esac
test "$(trusted_git -C "$staging" rev-parse HEAD)" = "$commit"
mv -- "$staging" "$app_dir"
trap - EXIT HUP INT TERM
