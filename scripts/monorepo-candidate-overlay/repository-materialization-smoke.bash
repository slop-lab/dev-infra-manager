#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd -- "$script_dir/../.." && pwd)"
root_repository="${DIM_ROOT_REPOSITORY:-$workspace_root}"
reconcile="$root_repository/.dim/reconcile-repositories.sh"
test -f "$reconcile" || { echo "single-tree lifecycle not found: $reconcile" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

work_dir="$(mktemp -d /tmp/dim-single-repository-materialization.XXXXXX)"
cleanup() { rm -rf -- "$work_dir"; }
trap cleanup EXIT

source="$work_dir/source"
remote="$work_dir/remotes/root.git"
project_root="$work_dir/project-root"
workspace_data="$work_dir/data"
manifest="$work_dir/manifest.json"
mkdir -p "$source" "$work_dir/remotes" "$project_root/.dim" "$workspace_data"
GIT_MASTER=1 git init --bare "$remote" >/dev/null
GIT_MASTER=1 git -C "$source" init --initial-branch=main >/dev/null
printf 'root-initial\n' >"$source/content.txt"
GIT_MASTER=1 git -C "$source" add content.txt
GIT_MASTER=1 git -C "$source" -c user.name="DIM Snapshot" -c user.email="snapshot@dim.invalid" \
  commit -m initial >/dev/null
GIT_MASTER=1 git -C "$source" push "$remote" main >/dev/null
cp -- "$root_repository/.dim/workspace-repositories.json" "$project_root/.dim/workspace-repositories.json"
jq -n --arg root "$project_root" --arg data "$workspace_data" --arg base "$work_dir/remotes" \
  '{schemaVersion:3,root:{repository:"root",ref:"refs/heads/main",commit:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",path:$root},data:{path:$data},gitBaseUrl:$base,hostAliases:{},runtime:{capabilities:[]}}' \
  >"$manifest"

DIM_PROJECT_ROOT="$project_root" DIM_PROJECT_MANIFEST="$manifest" \
  DIM_WORKSPACE_DATA="$workspace_data" sh "$reconcile"
checkout="$workspace_data/workspace"
test "$(GIT_MASTER=1 git -C "$checkout" branch --show-current)" = main
test "$(<"$checkout/content.txt")" = root-initial
test "$(GIT_MASTER=1 git -C "$checkout" rev-parse HEAD)" = \
  "$(GIT_MASTER=1 git -C "$source" rev-parse HEAD)"

printf 'agent-work\n' >>"$checkout/content.txt"
mkdir "$work_dir/no-git"
printf '#!/bin/sh\necho "trusted setup invoked Git for an existing checkout" >&2\nexit 99\n' \
  >"$work_dir/no-git/git"
chmod +x "$work_dir/no-git/git"
PATH="$work_dir/no-git:$PATH" DIM_PROJECT_ROOT="$project_root" \
  DIM_PROJECT_MANIFEST="$manifest" DIM_WORKSPACE_DATA="$workspace_data" \
  sh "$reconcile"
test "$(<"$checkout/content.txt")" = $'root-initial\nagent-work'

hostile_root="$work_dir/hostile-project-root"
hostile_data="$work_dir/hostile-data"
outside_git="$work_dir/outside-git"
mkdir -p "$hostile_root/.dim" "$hostile_data/workspace" "$outside_git/info"
cp -- "$project_root/.dim/workspace-repositories.json" \
  "$hostile_root/.dim/workspace-repositories.json"
printf 'outside-before\n' >"$outside_git/info/exclude"
ln -s "$outside_git" "$hostile_data/workspace/.git"
if DIM_PROJECT_ROOT="$hostile_root" DIM_PROJECT_MANIFEST="$manifest" \
  DIM_WORKSPACE_DATA="$hostile_data" sh "$reconcile"; then
  echo "single-tree reconciliation accepted a symbolic-link .git directory" >&2
  exit 1
fi
test "$(<"$outside_git/info/exclude")" = outside-before

echo repository-materialization-smoke-ok
