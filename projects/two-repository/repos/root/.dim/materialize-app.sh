#!/usr/bin/env sh
set -eu

: "${DIM_PROJECT_ROOT:?DIM_PROJECT_ROOT is required}"
: "${DIM_PROJECT_MANIFEST:?DIM_PROJECT_MANIFEST is required}"

entry="$(jq -ce '.repositories.app' "$DIM_PROJECT_MANIFEST")"
test "$(printf '%s' "$entry" | jq -r '.phase')" = ready || {
  echo "Project repository is not ready: app" >&2
  exit 1
}
workspace_url="$(printf '%s' "$entry" | jq -er '.workspaceUrl | select(type == "string" and length > 0)')"
ref="$(printf '%s' "$entry" | jq -er '.ref | select(type == "string" and length > 0)')"
commit="$(printf '%s' "$entry" | jq -er '.commit | select(type == "string" and test("^[0-9a-f]{40,64}$"))')"
case "$ref" in
  refs/heads/|refs/)
    echo "Project repository ref is not a full nonempty ref: app" >&2
    exit 1
    ;;
  refs/*) ;;
  *)
    echo "Project repository ref is not a full ref: app" >&2
    exit 1
    ;;
esac

app_dir="$DIM_PROJECT_ROOT/app"
if test -d "$app_dir/.git"; then
  exit 0
fi
if test -e "$app_dir" || test -L "$app_dir"; then
  echo "app checkout path exists but is not a Git repository: $app_dir" >&2
  exit 1
fi

staging="$(mktemp -d "$DIM_PROJECT_ROOT/.app-materialize.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT HUP INT TERM

trusted_git() {
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 \
    GIT_TERMINAL_PROMPT=0 \
    git -c core.hooksPath=/dev/null "$@"
}

trusted_git init "$staging" >/dev/null
trusted_git -C "$staging" remote add origin "$workspace_url"
trusted_git -C "$staging" fetch --no-tags origin "$commit"
test "$(trusted_git -C "$staging" rev-parse "${commit}^{commit}")" = "$commit"
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
