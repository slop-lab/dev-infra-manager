#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
suffix="$PPID-$$"
project_name="project-$suffix"
workspace_name="project-$suffix"
image_name="dim-project-$suffix:smoke"
state_root="$(mktemp -d /tmp/dim-project-state.XXXXXX)"
source_root="$(mktemp -d /tmp/dim-project-source.XXXXXX)"
worktree="$source_root/worktree"
bare_repo="$source_root/project.git"
dim_bin="${DIM_BIN:-dim}"

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$state_root/dim.json"
bash "$script_dir/configure-user-backend.bash" runc

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    "$dim_bin" discard "$workspace_name" --yes >/dev/null 2>&1 || true
  fi
  if docker container inspect dim-gitea >/dev/null 2>&1; then
    local credentials admin_username admin_password
    credentials="$(docker exec dim-gitea cat /data/dim/credentials.json 2>/dev/null || true)"
    if [[ -n "$credentials" ]]; then
      admin_username="$(printf '%s' "$credentials" | jq -r .adminUsername)"
      admin_password="$(printf '%s' "$credentials" | jq -r .adminPassword)"
      curl --fail --silent --show-error \
        --user "$admin_username:$admin_password" \
        --request DELETE \
        "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/orgs/dim-$project_name" \
        >/dev/null 2>&1 || true
    fi
  fi
  find "$state_root" -depth -delete 2>/dev/null || true
  find "$source_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

if [[ "$dim_bin" == */* ]]; then
  test -x "$dim_bin"
else
  command -v "$dim_bin" >/dev/null
fi

git init --initial-branch=main "$worktree" >/dev/null
git -C "$worktree" config user.name "Project Smoke"
git -C "$worktree" config user.email "project-smoke@dim.invalid"
printf '%s\n' 'hello-from-project-image' > "$worktree/message.txt"
printf '%s\n' \
  'FROM alpine:3.22' \
  'COPY message.txt /message.txt' \
  'CMD ["cat", "/message.txt"]' \
  > "$worktree/Dockerfile"
mkdir -p "$worktree/.dim"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'set -eu' \
  'test ! -f .dim/fail-setup' \
  "docker build --quiet --tag '$image_name' . >/dev/null" \
  > "$worktree/.dim/setup.sh"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'set -eu' \
  'task="${1:?task is required}"' \
  'shift' \
  'case "$task" in' \
  "  verify) exec docker run --rm '$image_name' \"\$@\" ;;" \
  '  *) echo "unknown task: $task" >&2; exit 2 ;;' \
  'esac' \
  > "$worktree/.dim/entrypoint.sh"
git -C "$worktree" add .dim Dockerfile message.txt
git -C "$worktree" commit -m 'add project development image' >/dev/null
git clone --bare "$worktree" "$bare_repo" >/dev/null

"$dim_bin" project create "$project_name" >/dev/null
"$dim_bin" repo create "$project_name" root --root --ref main >/dev/null
repo_url="$("$dim_bin" repo url "$project_name" root)"
"$dim_bin" x git --git-dir "$bare_repo" push "$repo_url" --all >/dev/null
"$dim_bin" repo protect "$project_name" root >/dev/null

# Registration must be sufficient: neither the seed checkout nor bare repository
# remains available while the workspace clones and builds the project.
find "$source_root" -depth -delete

"$dim_bin" create "$project_name" "$workspace_name" >/dev/null

output="$("$dim_bin" run "$workspace_name" verify)"
test "$output" = "hello-from-project-image"

"$dim_bin" exec "$workspace_name" -- touch .dim/fail-setup
if "$dim_bin" setup "$workspace_name" >/dev/null 2>&1; then
  echo "failing project setup unexpectedly succeeded" >&2
  exit 1
fi
test "$("$dim_bin" show "$workspace_name" --json | jq -r .phase)" = "setup-error"
"$dim_bin" exec "$workspace_name" -- rm .dim/fail-setup
"$dim_bin" setup "$workspace_name" >/dev/null
test "$("$dim_bin" show "$workspace_name" --json | jq -r .phase)" = "ready"

"$dim_bin" stop "$workspace_name" >/dev/null
"$dim_bin" start "$workspace_name" >/dev/null
"$dim_bin" exec "$workspace_name" -- \
  docker image inspect "$image_name" >/dev/null

output="$("$dim_bin" run "$workspace_name" verify)"
test "$output" = "hello-from-project-image"

"$dim_bin" discard "$workspace_name" --yes >/dev/null

echo "container-project-smoke-ok"
