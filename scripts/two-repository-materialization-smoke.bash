#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd -- "$script_dir/../.." && pwd)"
examples_root="${DIM_EXAMPLES_ROOT:-$workspace_root/examples}"
materialize="$examples_root/projects/two-repository/repos/root/.dim/materialize-app.sh"
test -f "$materialize" || {
  echo "two-repository app materializer not found: $materialize" >&2
  exit 1
}

work_dir="$(mktemp -d /tmp/dim-two-repository-materialization.XXXXXX)"
cleanup() { rm -rf -- "$work_dir"; }
trap cleanup EXIT

source_bare="$work_dir/app.git"
source_worktree="$work_dir/source"
git init --bare "$source_bare" >/dev/null
git init --initial-branch=main "$source_worktree" >/dev/null
git -C "$source_worktree" config user.name "Two repository materialization smoke"
git -C "$source_worktree" config user.email "smoke@dim.invalid"
printf 'initial\n' >"$source_worktree/content.txt"
git -C "$source_worktree" add content.txt
git -C "$source_worktree" commit -m initial >/dev/null
initial_commit="$(git -C "$source_worktree" rev-parse HEAD)"
git -C "$source_worktree" remote add origin "$source_bare"
git -C "$source_worktree" push origin main >/dev/null

manifest="$work_dir/manifest.json"
write_manifest() {
  local url="$1"
  local phase="$2"
  local ref="$3"
  local commit="$4"
  jq -n --arg url "$url" --arg phase "$phase" --arg ref "$ref" --arg commit "$commit" \
    '{repositories:{app:{workspaceUrl:$url,phase:$phase,root:false,requestedRef:$ref,ref:$ref,commit:$commit}}}' \
    >"$manifest"
}

run_materialize() {
  local project_root="$1"
  DIM_PROJECT_ROOT="$project_root" DIM_PROJECT_MANIFEST="$manifest" sh "$materialize"
}

assert_no_staging() {
  local project_root="$1"
  local staging=("$project_root"/.app-materialize.*)
  test "${#staging[@]}" -eq 0
}

echo '[two-repository-materialization] use the exact commit for a full branch ref after movement'
printf 'moved\n' >"$source_worktree/content.txt"
git -C "$source_worktree" commit -am moved >/dev/null
moved_commit="$(git -C "$source_worktree" rev-parse HEAD)"
git -C "$source_worktree" push origin main >/dev/null
project_root="$work_dir/branch-project"
mkdir "$project_root"
write_manifest "$source_bare" ready refs/heads/main "$initial_commit"
run_materialize "$project_root"
test "$(git -C "$project_root/app" rev-parse HEAD)" = "$initial_commit"
test "$(git -C "$project_root/app" branch --show-current)" = main
test "$(cat "$project_root/app/content.txt")" = initial
assert_no_staging "$project_root"

echo '[two-repository-materialization] detach non-branch refs at the exact commit'
project_root="$work_dir/tag-project"
mkdir "$project_root"
write_manifest "$source_bare" ready refs/tags/example "$moved_commit"
run_materialize "$project_root"
test "$(git -C "$project_root/app" rev-parse HEAD)" = "$moved_commit"
test -z "$(git -C "$project_root/app" branch --show-current)"

echo '[two-repository-materialization] reject non-full refs before invoking Git'
mkdir "$work_dir/reject-git"
cat >"$work_dir/reject-git/git" <<EOF
#!/bin/sh
touch '$work_dir/non-full-ref-invoked-git'
exit 99
EOF
chmod +x "$work_dir/reject-git/git"
rejected_ref_index=0
for rejected_ref in main refs/ refs/heads/; do
  project_root="$work_dir/rejected-ref-$rejected_ref_index"
  mkdir "$project_root"
  write_manifest "$source_bare" ready "$rejected_ref" "$moved_commit"
  if PATH="$work_dir/reject-git:$PATH" run_materialize "$project_root" >/dev/null 2>&1; then
    echo "materialization unexpectedly accepted ref: $rejected_ref" >&2
    exit 1
  fi
  test ! -e "$work_dir/non-full-ref-invoked-git"
  test ! -e "$project_root/app"
  assert_no_staging "$project_root"
  rejected_ref_index=$((rejected_ref_index + 1))
done

echo '[two-repository-materialization] ignore hostile system/global config and hooks'
project_root="$work_dir/hostile-project"
hostile_home="$work_dir/hostile-home"
hooks="$work_dir/hooks"
mkdir "$project_root" "$hostile_home" "$hooks"
cat >"$hooks/post-checkout" <<EOF
#!/bin/sh
touch '$work_dir/hostile-hook-ran'
EOF
chmod +x "$hooks/post-checkout"
printf '[core]\n\thooksPath = %s\n[protocol "file"]\n\tallow = never\n' "$hooks" >"$hostile_home/.gitconfig"
cp "$hostile_home/.gitconfig" "$work_dir/system.gitconfig"
write_manifest "$source_bare" ready refs/heads/main "$moved_commit"
HOME="$hostile_home" GIT_CONFIG_SYSTEM="$work_dir/system.gitconfig" run_materialize "$project_root"
test ! -e "$work_dir/hostile-hook-ran"
test "$(git -C "$project_root/app" rev-parse HEAD)" = "$moved_commit"

echo '[two-repository-materialization] reject unready and malformed manifest entries'
for phase_commit in \
  "creating:$moved_commit" \
  'ready:ABCDEF' \
  'ready:0000000000000000000000000000000000000000'
do
  phase="${phase_commit%%:*}"
  commit="${phase_commit#*:}"
  project_root="$work_dir/rejected-${phase}-${commit:0:8}"
  mkdir "$project_root"
  write_manifest "$source_bare" "$phase" refs/heads/main "$commit"
  if run_materialize "$project_root" >/dev/null 2>&1; then
    echo "materialization unexpectedly accepted phase=$phase commit=$commit" >&2
    exit 1
  fi
  test ! -e "$project_root/app"
  assert_no_staging "$project_root"
done

echo '[two-repository-materialization] clean failed fetches and permit a retry'
project_root="$work_dir/retry-project"
mkdir "$project_root" \
  "$project_root/.app-materialize" \
  "$project_root/.app-materialize.foreign" \
  "$project_root/.app-materialize.ABC123"
printf 'fixed\n' >"$project_root/.app-materialize/content"
printf 'foreign\n' >"$project_root/.app-materialize.foreign/content"
printf 'collision\n' >"$project_root/.app-materialize.ABC123/content"
write_manifest "$work_dir/missing.git" ready refs/heads/main "$moved_commit"
if run_materialize "$project_root" >/dev/null 2>&1; then
  echo 'materialization unexpectedly accepted an unavailable repository' >&2
  exit 1
fi
test ! -e "$project_root/app"
test "$(cat "$project_root/.app-materialize/content")" = fixed
test "$(cat "$project_root/.app-materialize.foreign/content")" = foreign
test "$(cat "$project_root/.app-materialize.ABC123/content")" = collision
test "$(printf '%s\n' "$project_root"/.app-materialize.* | wc -l)" -eq 2
write_manifest "$source_bare" ready refs/heads/main "$moved_commit"
run_materialize "$project_root"
test "$(git -C "$project_root/app" rev-parse HEAD)" = "$moved_commit"
test "$(cat "$project_root/.app-materialize/content")" = fixed
test "$(cat "$project_root/.app-materialize.foreign/content")" = foreign
test "$(cat "$project_root/.app-materialize.ABC123/content")" = collision
test "$(printf '%s\n' "$project_root"/.app-materialize.* | wc -l)" -eq 2

echo '[two-repository-materialization] reject an existing non-Git destination without mutation'
project_root="$work_dir/non-git-project"
mkdir -p "$project_root/app"
printf 'keep\n' >"$project_root/app/content.txt"
write_manifest "$source_bare" ready refs/heads/main "$moved_commit"
if run_materialize "$project_root" >/dev/null 2>&1; then
  echo 'materialization unexpectedly accepted a non-Git destination' >&2
  exit 1
fi
test "$(cat "$project_root/app/content.txt")" = keep
assert_no_staging "$project_root"

echo '[two-repository-materialization] never invoke Git in an existing checkout'
project_root="$work_dir/existing-project"
mkdir "$project_root"
write_manifest "$source_bare" ready refs/heads/main "$moved_commit"
run_materialize "$project_root"
mkdir "$work_dir/no-git"
cat >"$work_dir/no-git/git" <<'EOF'
#!/bin/sh
echo 'trusted materializer invoked Git in an existing checkout' >&2
exit 99
EOF
chmod +x "$work_dir/no-git/git"
PATH="$work_dir/no-git:$PATH" run_materialize "$project_root"

echo two-repository-materialization-smoke-ok
