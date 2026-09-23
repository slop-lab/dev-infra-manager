#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd -- "$script_dir/../.." && pwd)"
project_root="${DIM_EXAMPLES_ROOT:-$workspace_root/examples}/projects/two-repository/repos/root"
materialize="$project_root/.dim/materialize-app.sh"
test -f "$materialize"

work_dir="$(mktemp -d /tmp/dim-two-repository-materialization.XXXXXX)"
cleanup() { rm -rf -- "$work_dir"; }
trap cleanup EXIT

source_bare="$work_dir/app.git"
source_worktree="$work_dir/source"
git init --bare "$source_bare" >/dev/null
git init --initial-branch=main "$source_worktree" >/dev/null
git -C "$source_worktree" config user.name "Two repository materialization smoke"
git -C "$source_worktree" config user.email "smoke@dim.invalid"
cat >"$source_worktree/hello.bash" <<'EOF'
#!/usr/bin/env sh
set -eu
printf 'hello from Project-owned app checkout\n'
EOF
chmod +x "$source_worktree/hello.bash"
git -C "$source_worktree" add hello.bash
git -C "$source_worktree" commit -m initial >/dev/null
initial_commit="$(git -C "$source_worktree" rev-parse HEAD)"
git -C "$source_worktree" remote add origin "$source_bare"
git -C "$source_worktree" push origin main >/dev/null

manifest="$work_dir/manifest.json"
write_manifest() {
  jq -n --arg base "$1" --arg commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    '{schemaVersion:3,root:{repository:"root",ref:"refs/heads/main",commit:$commit,path:"/run/dim/project-root"},data:{path:"/var/lib/dim/workspace-data"},gitBaseUrl:$base,hostAliases:{},runtime:{capabilities:[]}}' \
    >"$manifest"
}
write_manifest "$work_dir"

run_materialize() {
  DIM_PROJECT_ROOT="$project_root" \
    DIM_PROJECT_MANIFEST="$manifest" \
    DIM_WORKSPACE_DATA="$1" \
    sh "$materialize"
}

assert_no_staging() {
  local staging=("$1"/.app-materialize.*)
  test "${#staging[@]}" -eq 0
}

echo '[two-repository-materialization] materialize the reviewed app ref and run its demo command'
data_root="$work_dir/data"
mkdir "$data_root"
run_materialize "$data_root"
test "$(git -C "$data_root/app" rev-parse HEAD)" = "$initial_commit"
test "$(git -C "$data_root/app" branch --show-current)" = main
test "$(sh "$data_root/app/hello.bash")" = 'hello from Project-owned app checkout'
assert_no_staging "$data_root"

echo '[two-repository-materialization] never invoke Git in an existing agent checkout'
printf 'moved\n' >>"$source_worktree/hello.bash"
git -C "$source_worktree" commit -am moved >/dev/null
git -C "$source_worktree" push origin main >/dev/null
mkdir "$work_dir/no-git"
cat >"$work_dir/no-git/git" <<'EOF'
#!/bin/sh
echo 'trusted materializer invoked Git in an existing checkout' >&2
exit 99
EOF
chmod +x "$work_dir/no-git/git"
PATH="$work_dir/no-git:$PATH" run_materialize "$data_root"
test "$(git -C "$data_root/app" rev-parse HEAD)" = "$initial_commit"

echo '[two-repository-materialization] ignore hostile outer Git config and hooks'
hostile_data="$work_dir/hostile-data"
hostile_home="$work_dir/hostile-home"
hooks="$work_dir/hooks"
mkdir "$hostile_data" "$hostile_home" "$hooks"
cat >"$hooks/post-checkout" <<EOF
#!/bin/sh
touch '$work_dir/hostile-hook-ran'
EOF
chmod +x "$hooks/post-checkout"
printf '[core]\n\thooksPath = %s\n[protocol "file"]\n\tallow = never\n' "$hooks" >"$hostile_home/.gitconfig"
cp "$hostile_home/.gitconfig" "$work_dir/system.gitconfig"
HOME="$hostile_home" GIT_CONFIG_SYSTEM="$work_dir/system.gitconfig" run_materialize "$hostile_data"
test ! -e "$work_dir/hostile-hook-ran"
assert_no_staging "$hostile_data"

echo '[two-repository-materialization] preserve failed staging and permit explicit retry'
retry_data="$work_dir/retry-data"
mkdir "$retry_data"
write_manifest "$work_dir/missing"
if run_materialize "$retry_data" >/dev/null 2>&1; then
  echo 'materialization unexpectedly accepted an unavailable repository' >&2
  exit 1
fi
test ! -e "$retry_data/app"
assert_no_staging "$retry_data"
write_manifest "$work_dir"
run_materialize "$retry_data"
test -d "$retry_data/app/.git"

echo '[two-repository-materialization] reject a non-Git destination without mutation'
non_git_data="$work_dir/non-git-data"
mkdir -p "$non_git_data/app"
printf 'keep\n' >"$non_git_data/app/content.txt"
if run_materialize "$non_git_data" >/dev/null 2>&1; then
  echo 'materialization unexpectedly accepted a non-Git destination' >&2
  exit 1
fi
test "$(cat "$non_git_data/app/content.txt")" = keep
assert_no_staging "$non_git_data"

echo two-repository-materialization-smoke-ok
