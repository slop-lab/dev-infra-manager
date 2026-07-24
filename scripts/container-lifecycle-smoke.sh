#!/usr/bin/env bash
set -euo pipefail

suffix="$PPID-$$"
repo_name="smoke-$suffix"
workspace_name="smoke-$suffix"
state_root="$(mktemp -d /tmp/dim-lifecycle-state.XXXXXX)"
source_root="$(mktemp -d /tmp/dim-lifecycle-source.XXXXXX)"
worktree="$source_root/worktree"
bare_repo="$source_root/project.git"

export DIM_STATE_ROOT="$state_root"
export DIM_WORKSPACE_BACKEND="${DIM_WORKSPACE_BACKEND:-runc}"

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    pnpm run cli -- workspace discard "$workspace_name" --yes >/dev/null 2>&1 || true
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
        "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/repos/$admin_username/$repo_name" \
        >/dev/null 2>&1 || true
    fi
  fi
  find "$state_root" -depth -delete 2>/dev/null || true
  find "$source_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

git init --initial-branch=main "$worktree" >/dev/null
git -C "$worktree" config user.name "Lifecycle Smoke"
git -C "$worktree" config user.email "smoke@dim.invalid"
printf 'initial\n' > "$worktree/README.md"
git -C "$worktree" add README.md
git -C "$worktree" commit -m initial >/dev/null
git clone --bare "$worktree" "$bare_repo" >/dev/null

pnpm run cli -- repo register --name "$repo_name" "$bare_repo" >/dev/null
pnpm run cli -- workspace create "$repo_name" "$workspace_name" >/dev/null
pnpm run cli -- workspace exec "$workspace_name" -- sh -c "
  test \"\\\$(git config user.name)\" = 'dim/$workspace_name'
  git checkout -b 'agent/$workspace_name'
  printf 'workspace\n' >> README.md
  git commit -am workspace >/dev/null
  git push origin HEAD:'refs/heads/agent/$workspace_name' >/dev/null
  if git push origin HEAD:refs/heads/main >/dev/null 2>&1; then
    echo 'protected branch accepted a direct workspace push' >&2
    exit 1
  fi
  docker run --rm \
    --env DIM_GIT_USERNAME \
    --env DIM_GIT_TOKEN \
    alpine:3.22 sh -c \
    'test -n \"\$DIM_GIT_USERNAME\"; test -n \"\$DIM_GIT_TOKEN\"; wget -qO- https://example.com >/dev/null'
" >/dev/null

test "$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}{{end}}' "dim-ws-$workspace_name")" \
  = "volume:dim-ws-$workspace_name-docker:/var/lib/docker"
pnpm run cli -- workspace stop "$workspace_name" >/dev/null
pnpm run cli -- workspace start "$workspace_name" >/dev/null
pnpm run cli -- workspace exec "$workspace_name" -- sh -c \
  "test -d .git; docker image inspect alpine:3.22 >/dev/null" >/dev/null
pnpm run cli -- workspace discard "$workspace_name" --yes >/dev/null

echo "container-lifecycle-smoke-ok"
