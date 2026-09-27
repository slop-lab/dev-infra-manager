#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$PWD/shared-upstream-example}"
upstream="$target_dir/upstream.git"

[[ ! -e "$target_dir" ]] || {
  echo "already exists: $target_dir" >&2
  exit 2
}
mkdir -p "$target_dir/repositories"
for alias in root api; do
  cp -R "$example_dir/repos/$alias" "$target_dir/repositories/$alias"
  git init --initial-branch=main "$target_dir/repositories/$alias" >/dev/null
  git -C "$target_dir/repositories/$alias" add -A
  git -C "$target_dir/repositories/$alias" commit -m "initial shared-upstream-$alias" >/dev/null
done

git init --bare "$upstream" >/dev/null
sed -i "s|__DIM_SHARED_UPSTREAM_URL__|$(realpath "$upstream")|" \
  "$target_dir/repositories/root/.dim/repos.yml"
git -C "$target_dir/repositories/root" add .dim/repos.yml
git -C "$target_dir/repositories/root" commit --amend --no-edit >/dev/null
git -C "$target_dir/repositories/root" tag root-v1
git -C "$target_dir/repositories/api" tag v1
git -C "$target_dir/repositories/root" push "$upstream" \
  main:refs/heads/main refs/tags/root-v1:refs/tags/root-v1 >/dev/null
git -C "$target_dir/repositories/api" push "$upstream" \
  main:refs/heads/api/main refs/tags/v1:refs/tags/api/v1 >/dev/null

echo "Created a shared upstream and logical repositories in $target_dir"
