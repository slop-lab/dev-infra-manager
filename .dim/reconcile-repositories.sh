#!/usr/bin/env sh
set -eu

: "${DIM_PROJECT_ROOT:?DIM_PROJECT_ROOT is required}"
: "${DIM_PROJECT_MANIFEST:?DIM_PROJECT_MANIFEST is required}"
: "${DIM_WORKSPACE_DATA:?DIM_WORKSPACE_DATA is required}"
test -r "$DIM_PROJECT_MANIFEST"
policy="$DIM_PROJECT_ROOT/.dim/workspace-repositories.json"
test -r "$policy"
test "$(jq -r '.schemaVersion' "$policy")" = 1
git_base_url="$(jq -er '.gitBaseUrl | select(type == "string" and length > 0)' "$DIM_PROJECT_MANIFEST")"

trusted_git() {
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 \
    GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null "$@"
}

materialize() {
  alias="$1"
  configured_ref="$(jq -er --arg alias "$alias" '.repositories[$alias].ref | select(type == "string" and length > 0)' "$policy")"
  relative_path="$(jq -er --arg alias "$alias" '.repositories[$alias].path | select(type == "string" and length > 0)' "$policy")"
  case "$relative_path" in
    /*|.|..|../*|*/../*|*/..) echo "invalid workspace repository path: $relative_path" >&2; exit 2 ;;
  esac
  case "$configured_ref" in
    refs/*) ref="$configured_ref" ;;
    *) ref="refs/heads/$configured_ref" ;;
  esac
  destination="$DIM_WORKSPACE_DATA/$relative_path"
  test -d "$destination/.git" && return
  if test -e "$destination" || test -L "$destination"; then
    echo "workspace repository path exists but is not a Git repository: $destination" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$destination")"
  staging="$(mktemp -d "$DIM_WORKSPACE_DATA/.repository-materialize.XXXXXX")"
  trap 'rm -rf -- "$staging"' EXIT HUP INT TERM
  trusted_git init "$staging" >/dev/null
  trusted_git -C "$staging" remote add origin "$git_base_url/$alias.git"
  case "$ref" in
    refs/heads/*)
      branch="${ref#refs/heads/}"
      trusted_git -C "$staging" fetch --no-tags origin "$ref:refs/remotes/origin/$branch"
      trusted_git -C "$staging" checkout -b "$branch" --track "origin/$branch" >/dev/null
      ;;
    *)
      trusted_git -C "$staging" fetch --no-tags origin "$ref"
      commit="$(trusted_git -C "$staging" rev-parse 'FETCH_HEAD^{commit}')"
      trusted_git -C "$staging" checkout --detach "$commit" >/dev/null
      ;;
  esac
  mv -- "$staging" "$destination"
  trap - EXIT HUP INT TERM
}

for alias in $(jq -er '.repositories | to_entries | sort_by(.value.path | split("/") | length) | .[].key' "$policy"); do
  materialize "$alias"
done

integrated_root="$DIM_WORKSPACE_DATA/workspace"
exclude="$integrated_root/.git/info/exclude"
for path in \
  node_modules/ .pnpm-store/ \
  core/ core-development/ \
  plugin-dns-cloudflare/ plugin-dns-cloudflare-development/ \
  plugin-external-urls/ plugin-external-urls-development/ \
  verification/ examples/ specification/
do
  grep -Fxq "$path" "$exclude" || printf '%s\n' "$path" >>"$exclude"
done
