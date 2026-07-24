#!/usr/bin/env bash
set -euo pipefail

suffix="$PPID-$$"
project_repo="multi-project-$suffix"
api_repo="multi-api-$suffix"
worker_repo="multi-worker-$suffix"
secret_repo="multi-secret-$suffix"
workspace_name="multi-$suffix"
state_root="$(mktemp -d /tmp/dim-multi-state.XXXXXX)"
source_root="$(mktemp -d /tmp/dim-multi-source.XXXXXX)"
dim_bin="${DIM_BIN:-dim}"

export DIM_STATE_ROOT="$state_root"
export DIM_WORKSPACE_RUNTIME="${DIM_WORKSPACE_RUNTIME:-runc}"
export DIM_WORKSPACE_PRIVILEGED="${DIM_WORKSPACE_PRIVILEGED:-yes}"

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    "$dim_bin" workspace discard "$workspace_name" --yes >/dev/null 2>&1 || true
  fi
  if docker container inspect dim-gitea >/dev/null 2>&1; then
    local credentials admin_username admin_password repo
    credentials="$(docker exec dim-gitea cat /data/dim/credentials.json 2>/dev/null || true)"
    if [[ -n "$credentials" ]]; then
      admin_username="$(printf '%s' "$credentials" | jq -r .adminUsername)"
      admin_password="$(printf '%s' "$credentials" | jq -r .adminPassword)"
      for repo in "$project_repo" "$api_repo" "$worker_repo" "$secret_repo"; do
        curl --fail --silent --show-error \
          --user "$admin_username:$admin_password" \
          --request DELETE \
          "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/repos/$admin_username/$repo" \
          >/dev/null 2>&1 || true
      done
    fi
  fi
  find "$state_root" -depth -delete 2>/dev/null || true
  find "$source_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

create_repo() {
  local name="$1"
  local message="$2"
  local worktree="$source_root/$name"
  local bare="$source_root/$name.git"
  git init --initial-branch=main "$worktree" >/dev/null
  git -C "$worktree" config user.name "DIM Multi Repo Smoke"
  git -C "$worktree" config user.email "multi-smoke@dim.invalid"
  printf '%s\n' "$message" > "$worktree/message.txt"
  git -C "$worktree" add message.txt
  git -C "$worktree" commit -m initial >/dev/null
  git clone --bare "$worktree" "$bare" >/dev/null
  "$dim_bin" repo register --name "$name" "$bare" >/dev/null
}

create_repo "$api_repo" "api-source-ok"
create_repo "$worker_repo" "worker-source-ok"
create_repo "$secret_repo" "secret-source-ok"

project_worktree="$source_root/$project_repo"
project_bare="$source_root/$project_repo.git"
git init --initial-branch=main "$project_worktree" >/dev/null
git -C "$project_worktree" config user.name "DIM Multi Repo Smoke"
git -C "$project_worktree" config user.email "multi-smoke@dim.invalid"
mkdir -p "$project_worktree/.dim"

printf '%s\n' \
  'services:' \
  '  root-compose-must-be-ignored:' \
  '    image: alpine:3.22' \
  '    command: ["sleep", "infinity"]' \
  > "$project_worktree/compose.yaml"

printf '%s\n' \
  '#!/usr/bin/env sh' \
  'set -eu' \
  'task="${1:?task is required}"' \
  'shift' \
  'case "$task" in' \
  '  verify)' \
  '    exec docker compose --file .dim/docker-compose.yml run --rm verifier "$@"' \
  '    ;;' \
  '  version)' \
  '    exec cat version.txt' \
  '    ;;' \
  '  *) echo "unknown task: $task" >&2; exit 2 ;;' \
  'esac' \
  > "$project_worktree/.dim/entrypoint.sh"

printf '%s\n' \
  'services:' \
  '  api-checkout:' \
  '    profiles: [development]' \
  '    image: alpine:3.22' \
  '    environment:' \
  "      REPO_URL: \${DIM_GIT_BASE_URL}/dim-admin/$api_repo.git" \
  '      DIM_WORKSPACE_NAME: ${DIM_WORKSPACE_NAME}' \
  '      DIM_GIT_USERNAME: ${DIM_GIT_USERNAME}' \
  '      DIM_GIT_TOKEN: ${DIM_GIT_TOKEN}' \
  '      GIT_ASKPASS: /usr/local/bin/dim-git-askpass' \
  '      GIT_TERMINAL_PROMPT: "0"' \
  '    entrypoint: ["/bin/sh", "-c"]' \
  '    command: ["apk add --no-cache git >/dev/null && if ! test -d /source/.git; then git clone $$REPO_URL /source && cd /source && git checkout -b agent/$$DIM_WORKSPACE_NAME && git config user.name Nested-Service && git config user.email nested@dim.invalid && echo nested-service-ok > nested.txt && git add nested.txt && git commit -m nested-service && git push origin HEAD; fi"]' \
  '    volumes:' \
  '      - api-source:/source' \
  '      - /usr/local/bin/dim-git-askpass:/usr/local/bin/dim-git-askpass:ro' \
  '  worker-checkout:' \
  '    profiles: [development]' \
  '    image: alpine:3.22' \
  '    environment:' \
  "      REPO_URL: \${DIM_GIT_BASE_URL}/dim-admin/$worker_repo.git" \
  '    entrypoint: ["/bin/sh", "-c"]' \
  '    command: ["apk add --no-cache git >/dev/null && { test -d /source/.git || git clone $$REPO_URL /source; }"]' \
  '    volumes: [worker-source:/source]' \
  '  secret-checkout:' \
  '    profiles: [secrets]' \
  '    image: alpine:3.22' \
  '    environment:' \
  "      REPO_URL: \${DIM_GIT_BASE_URL}/dim-admin/$secret_repo.git" \
  '    entrypoint: ["/bin/sh", "-c"]' \
  '    command: ["apk add --no-cache git >/dev/null && { test -d /source/.git || git clone $$REPO_URL /source; }"]' \
  '    volumes: [secret-source:/source]' \
  '  production-only:' \
  '    profiles: [production]' \
  '    image: alpine:3.22' \
  '    command: ["sh", "-c", "echo production-should-not-run > /production-ran && sleep infinity"]' \
  '  verifier:' \
  '    profiles: [development]' \
  '    image: alpine:3.22' \
  '    depends_on:' \
  '      api-checkout: {condition: service_completed_successfully}' \
  '      worker-checkout: {condition: service_completed_successfully}' \
  '      secret-checkout: {condition: service_completed_successfully}' \
  '    entrypoint: ["/bin/sh", "-c"]' \
  '    command: ["test \"$$(cat /api/message.txt)\" = api-source-ok && test \"$$(cat /worker/message.txt)\" = worker-source-ok && test \"$$(cat /secret/message.txt)\" = secret-source-ok && echo multi-repo-project-ok"]' \
  '    volumes:' \
  '      - api-source:/api:ro' \
  '      - worker-source:/worker:ro' \
  '      - secret-source:/secret:ro' \
  'volumes:' \
  '  api-source:' \
  '  worker-source:' \
  '  secret-source:' \
  > "$project_worktree/.dim/docker-compose.yml"

printf '%s\n' v1 > "$project_worktree/version.txt"
git -C "$project_worktree" add .dim compose.yaml version.txt
git -C "$project_worktree" commit -m 'add DIM project environment' >/dev/null
git clone --bare "$project_worktree" "$project_bare" >/dev/null
"$dim_bin" repo register --name "$project_repo" --protect 'release/*' "$project_bare" >/dev/null

"$dim_bin" workspace create "$project_repo" "$workspace_name" \
  --profile development \
  --profile secrets \
  >/dev/null

test "$("$dim_bin" workspace show "$workspace_name" | jq -c .profiles)" = '["development","secrets"]'
test "$("$dim_bin" workspace exec "$workspace_name" -- ls -1 /workspace)" = "project"
git ls-remote "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/dim-admin/$api_repo.git" \
  "refs/heads/agent/$workspace_name" | grep -q .

output="$("$dim_bin" workspace run "$workspace_name" verify)"
test "$output" = "multi-repo-project-ok"
test "$("$dim_bin" workspace run "$workspace_name" version)" = "v1"

if "$dim_bin" workspace exec "$workspace_name" -- \
  docker container inspect "dim-${workspace_name}-production-only-1" >/dev/null 2>&1; then
  echo "production-only profile unexpectedly ran" >&2
  exit 1
fi
if ! "$dim_bin" workspace exec "$workspace_name" -- sh -c \
  'test -z "$(docker ps -aq --filter name=root-compose-must-be-ignored)"'; then
  echo "root compose file was unexpectedly discovered" >&2
  exit 1
fi

credentials="$("$dim_bin" gitea credentials --show-secrets)"
writer_username="$(printf '%s' "$credentials" | jq -r .writerUsername)"
writer_password="$(printf '%s' "$credentials" | jq -r .writerPassword)"
git -C "$project_worktree" remote add managed \
  "http://$writer_username:$writer_password@127.0.0.1:${DIM_GITEA_PORT:-3300}/dim-admin/$project_repo.git"
printf '%s\n' v2 > "$project_worktree/version.txt"
git -C "$project_worktree" add version.txt
git -C "$project_worktree" commit -m 'update project version' >/dev/null
git -C "$project_worktree" push managed main >/dev/null

"$dim_bin" workspace update "$workspace_name" --profile production >/dev/null
test "$("$dim_bin" workspace run "$workspace_name" version)" = "v2"
"$dim_bin" workspace exec "$workspace_name" -- \
  docker container inspect "dim-${workspace_name}-production-only-1" >/dev/null

"$dim_bin" workspace update "$workspace_name" \
  --profile development \
  --profile secrets \
  >/dev/null
if "$dim_bin" workspace exec "$workspace_name" -- \
  docker container inspect "dim-${workspace_name}-production-only-1" >/dev/null 2>&1; then
  echo "old production profile container remained after profile replacement" >&2
  exit 1
fi
output="$("$dim_bin" workspace run "$workspace_name" verify)"
test "$output" = "multi-repo-project-ok"

find "$source_root" -depth -delete

"$dim_bin" workspace stop "$workspace_name" >/dev/null
"$dim_bin" workspace start "$workspace_name" >/dev/null
output="$("$dim_bin" workspace run "$workspace_name" verify)"
test "$output" = "multi-repo-project-ok"

"$dim_bin" workspace discard "$workspace_name" --yes >/dev/null

echo "container-multi-repo-project-smoke-ok"
