#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
checkout_root="$(cd -- "$script_dir/../../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-repository-materialization.XXXXXX)"
cleanup() { find "$work_dir" -depth -delete 2>/dev/null || true; }
trap cleanup EXIT

repositories=(development core core-development plugin-dns-cloudflare plugin-dns-cloudflare-development plugin-external-urls plugin-external-urls-development verification examples specification)
mkdir -p "$work_dir/sources" "$work_dir/integrated"
manifest="$work_dir/project.json"
printf '{"repositories":{' >"$manifest"
separator=""
for repository in "${repositories[@]}"; do
  source="$work_dir/sources/$repository.git"
  worktree="$work_dir/$repository"
  ref="dev/$repository"
  git init --bare "$source" >/dev/null
  git init --initial-branch="$ref" "$worktree" >/dev/null
  git -C "$worktree" config user.name "Repository materialization smoke"
  git -C "$worktree" config user.email "smoke@dim.invalid"
  printf '%s\n' "$repository-initial" >"$worktree/content.txt"
  git -C "$worktree" add content.txt
  git -C "$worktree" commit -m initial >/dev/null
  git -C "$worktree" remote add origin "$source"
  git -C "$worktree" push origin "$ref" >/dev/null
  printf '%s"%s":{"workspaceUrl":"%s","phase":"ready","root":false}' \
    "$separator" "$repository" "$source" >>"$manifest"
  separator=,
done
printf '}}\n' >>"$manifest"

DIM_PROJECT_MANIFEST="$manifest" DIM_INTEGRATED_ROOT="$work_dir/integrated" \
  sh "$checkout_root/.dim/reconcile-repositories.sh"

for repository in "${repositories[@]}"; do
  case "$repository" in
    development) path="$work_dir/integrated/workbench" ;;
    *) path="$work_dir/integrated/workbench/$repository" ;;
  esac
  test "$(git -C "$path" branch --show-current)" = "dev/$repository"
  test "$(cat "$path/content.txt")" = "$repository-initial"
done

# The reviewed outer lifecycle never invokes Git in an existing agent-controlled
# checkout. Both clean and dirty trees remain untouched; the agent can update a
# clean checkout using its own Git process.
printf 'core-updated\n' >"$work_dir/core/content.txt"
git -C "$work_dir/core" commit -am update >/dev/null
git -C "$work_dir/core" push origin dev/core >/dev/null
printf 'agent-work\n' >>"$work_dir/integrated/workbench/core-development/content.txt"
mkdir "$work_dir/no-git"
printf '#!/bin/sh\necho "trusted setup invoked Git for an existing checkout" >&2\nexit 99\n' \
  >"$work_dir/no-git/git"
chmod +x "$work_dir/no-git/git"
PATH="$work_dir/no-git:$PATH" \
  DIM_PROJECT_MANIFEST="$manifest" DIM_INTEGRATED_ROOT="$work_dir/integrated" \
  sh "$checkout_root/.dim/reconcile-repositories.sh"
test "$(cat "$work_dir/integrated/workbench/core/content.txt")" = core-initial
grep -q agent-work "$work_dir/integrated/workbench/core-development/content.txt"
git -C "$work_dir/integrated/workbench/core" pull --ff-only >/dev/null
test "$(cat "$work_dir/integrated/workbench/core/content.txt")" = core-updated

echo repository-materialization-smoke-ok
