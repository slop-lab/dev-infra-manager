#!/usr/bin/env sh
set -eu

app_dir="$DIM_PROJECT_ROOT/app"
if test -d "$app_dir/.git"; then
  exit 0
fi
if test -e "$app_dir"; then
  echo "app checkout path exists but is not a Git repository: $app_dir" >&2
  exit 1
fi

app_ref="$(jq -er '.repositories.app.ref' "$DIM_PROJECT_MANIFEST")"
temporary_app="$DIM_PROJECT_ROOT/.app-clone.$$"
trap 'rm -rf -- "$temporary_app"' EXIT HUP INT TERM
git clone --branch "$app_ref" --single-branch \
  "$DIM_GIT_BASE_URL/app.git" "$temporary_app"
mv "$temporary_app" "$app_dir"
trap - EXIT HUP INT TERM
