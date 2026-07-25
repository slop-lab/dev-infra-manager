#!/usr/bin/env bash
set -euo pipefail

suffix="$PPID-$$"
project_name="smoke-$suffix"
workspace_name="smoke-$suffix"
state_root="$(mktemp -d /tmp/dim-lifecycle-state.XXXXXX)"
source_root="$(mktemp -d /tmp/dim-lifecycle-source.XXXXXX)"
worktree="$source_root/worktree"
bare_repo="$source_root/project.git"

export DIM_STATE_ROOT="$state_root"
export DIM_WORKSPACE_BACKEND="${DIM_WORKSPACE_BACKEND:-runc}"

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    pnpm run cli -- discard "$workspace_name" --yes >/dev/null 2>&1 || true
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

git init --initial-branch=main "$worktree" >/dev/null
git -C "$worktree" config user.name "Lifecycle Smoke"
git -C "$worktree" config user.email "smoke@dim.invalid"
printf 'initial\n' > "$worktree/README.md"
git -C "$worktree" add README.md
git -C "$worktree" commit -m initial >/dev/null
git clone --bare "$worktree" "$bare_repo" >/dev/null

pnpm run cli -- project create "$project_name" >/dev/null
pnpm run cli -- repo create "$project_name" root --root --ref main --protect main >/dev/null
repo_url="$(pnpm run --silent cli -- repo url-for-host "$project_name" root)"
pnpm run cli -- x git --git-dir "$bare_repo" push "$repo_url" --all >/dev/null
pnpm run cli -- repo protect "$project_name" root >/dev/null
pnpm run cli -- repo import "$project_name" imported "$bare_repo" >/dev/null
git ls-remote "$(pnpm run --silent cli -- repo url-for-host "$project_name" imported)" \
  refs/heads/main | grep -q .
pnpm run cli -- create "$project_name" "$workspace_name" \
  --cpus 1.5 \
  --memory 3g \
  --pids-limit 1024 \
  >/dev/null
# The workspace's actual Docker resource names are an implementation detail
# owned by `dim show --json`, not something to reconstruct by hand: never
# assume a `dim-ws-<name>`-shaped prefix in test code or docs.
container_name="$(pnpm run --silent cli -- show "$workspace_name" --json | jq -r .containerName)"
test "$(docker inspect --format '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}' "$container_name")" \
  = "1500000000|3221225472|1024"
pnpm run cli -- exec "$workspace_name" -- sh -c "
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

volume_name="$(pnpm run --silent cli -- show "$workspace_name" --json | jq -r .dockerVolumeName)"
test "$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}{{end}}' "$container_name")" \
  = "volume:$volume_name:/var/lib/docker"
pnpm run cli -- stop "$workspace_name" >/dev/null
pnpm run cli -- start "$workspace_name" >/dev/null
pnpm run cli -- exec "$workspace_name" -- sh -c \
  "test -d .git; docker image inspect alpine:3.22 >/dev/null" >/dev/null
pnpm run cli -- discard "$workspace_name" --yes >/dev/null
pnpm run cli -- project purge "$project_name" --yes >/dev/null

echo "container-lifecycle-smoke-ok"
