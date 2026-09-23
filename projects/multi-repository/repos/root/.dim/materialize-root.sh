#!/usr/bin/env sh
set -eu
: "${DIM_PROJECT_MANIFEST:?}" "${DIM_WORKSPACE_DATA:?}"
destination="$DIM_WORKSPACE_DATA/project"
test -d "$destination/.git" && exit 0
if test -e "$destination" || test -L "$destination"; then echo "root checkout path is not a Git repository: $destination" >&2; exit 1; fi
alias="$(jq -er '.root.repository' "$DIM_PROJECT_MANIFEST")" ref="$(jq -er '.root.ref' "$DIM_PROJECT_MANIFEST")" commit="$(jq -er '.root.commit' "$DIM_PROJECT_MANIFEST")" base="$(jq -er '.gitBaseUrl' "$DIM_PROJECT_MANIFEST")"
staging="$(mktemp -d "$DIM_WORKSPACE_DATA/.root-materialize.XXXXXX")"; trap 'rm -rf -- "$staging"' EXIT HUP INT TERM
trusted_git() { GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null "$@"; }
trusted_git init "$staging" >/dev/null; trusted_git -C "$staging" remote add origin "$base/$alias.git"; trusted_git -C "$staging" fetch --no-tags origin "$ref"
test "$(trusted_git -C "$staging" rev-parse 'FETCH_HEAD^{commit}')" = "$commit"
case "$ref" in refs/heads/*) trusted_git -C "$staging" checkout -b "${ref#refs/heads/}" "$commit" >/dev/null ;; *) trusted_git -C "$staging" checkout --detach "$commit" >/dev/null ;; esac
mv -- "$staging" "$destination"; trap - EXIT HUP INT TERM
