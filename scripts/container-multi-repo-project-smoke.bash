#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
suffix="$PPID-$$"
project_name="multi-$suffix"
custom_project_name="multi-custom-$suffix"
retry_project_name="multi-retry-$suffix"
source_namespace="source-$suffix"
api_repo="api"
worker_repo="worker"
docs_repo="docs"
candidate_ref="refs/heads/candidate"
worker_candidate_ref="refs/heads/worker-candidate"
workspace_name="multi-$suffix"
rejected_workspace_name="multi-rejected-$suffix"
state_root="$(mktemp -d /tmp/dim-multi-state.XXXXXX)"
source_root="$(mktemp -d /tmp/dim-multi-source.XXXXXX)"
dim_bin="${DIM_BIN:-dim}"

gitea_request() {
  local method="$1" url="$2" username="$3" password="$4" body="${5:-}"
  GITEA_API_USERNAME="$username" GITEA_API_PASSWORD="$password" GITEA_API_BODY="$body" \
    node -e '
      const [method, url] = process.argv.slice(1);
      const authorization = Buffer.from(
        `${process.env.GITEA_API_USERNAME}:${process.env.GITEA_API_PASSWORD}`
      ).toString("base64");
      const body = process.env.GITEA_API_BODY || undefined;
      fetch(url, {
        method,
        headers: {
          authorization: `Basic ${authorization}`,
          ...(body ? { "content-type": "application/json" } : {})
        },
        body
      }).then((response) => {
        if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status}`);
      });
    ' "$method" "$url"
}

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$state_root/dim.json"
bash "$script_dir/configure-user-backend.bash" sysbox

cleanup() {
  local workspace
  for workspace in "$workspace_name" "$rejected_workspace_name"; do
    if [[ -f "$state_root/workspaces/$workspace.json" ]]; then
      "$dim_bin" workspace discard "$workspace" --yes >/dev/null 2>&1 || true
    fi
  done
  if docker container inspect dim-gitea >/dev/null 2>&1; then
    local credentials admin_username admin_password
    credentials="$(docker exec dim-gitea cat /data/dim/credentials.json 2>/dev/null || true)"
    if [[ -n "$credentials" ]]; then
      admin_username="$(printf '%s' "$credentials" | jq -r .adminUsername)"
      admin_password="$(printf '%s' "$credentials" | jq -r .adminPassword)"
      for organization in "dim-$project_name" "dim-$custom_project_name" "dim-$retry_project_name" "$source_namespace"; do
        gitea_request DELETE \
          "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/orgs/$organization" \
          "$admin_username" "$admin_password" \
          >/dev/null 2>&1 || true
      done
    fi
  fi
  find "$state_root" -depth -delete 2>/dev/null || true
  find "$source_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

managed_repository_refs() {
  local alias
  while IFS= read -r alias; do
    printf '%s\n' "$alias"
    git ls-remote --refs "$("$dim_bin" repo url "$project_name" "$alias")" | LC_ALL=C sort
  done < <("$dim_bin" repo list "$project_name" --json | jq -r 'sort_by(.alias)[].alias')
}

assert_workspace_create_rejected() {
  local expected_error="$1"
  local rejected_name="$2"
  shift 2
  local project_before workspaces_before workspace_before repositories_before refs_before rejection_error
  project_before="$("$dim_bin" project show "$project_name" --json | jq -Sc .)"
  workspaces_before="$("$dim_bin" workspace list --json | jq -Sc 'sort_by(.name)')"
  workspace_before="$("$dim_bin" workspace show "$workspace_name" --json | jq -Sc .)"
  repositories_before="$("$dim_bin" repo list "$project_name" --json | jq -Sc 'sort_by(.alias)')"
  refs_before="$(managed_repository_refs)"
  if rejection_error="$("$dim_bin" workspace create "$project_name" "$rejected_name" \
    --profile development --profile documentation "$@" 2>&1)"; then
    echo "rejected workspace creation unexpectedly succeeded" >&2
    return 1
  fi
  grep -Fq "$expected_error" <<<"$rejection_error"
  test "$("$dim_bin" project show "$project_name" --json | jq -Sc .)" = "$project_before"
  test "$("$dim_bin" workspace list --json | jq -Sc 'sort_by(.name)')" = "$workspaces_before"
  test "$("$dim_bin" workspace show "$workspace_name" --json | jq -Sc .)" = "$workspace_before"
  test "$("$dim_bin" repo list "$project_name" --json | jq -Sc 'sort_by(.alias)')" = "$repositories_before"
  test "$(managed_repository_refs)" = "$refs_before"
}

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
}

create_repo "$api_repo" "api-source-ok"
create_repo "$worker_repo" "worker-source-ok"
create_repo "$docs_repo" "docs-source-ok"
git -C "$source_root/$api_repo" switch -c candidate >/dev/null
printf '%s\n' candidate-source-ok > "$source_root/$api_repo/candidate.txt"
git -C "$source_root/$api_repo" add candidate.txt
git -C "$source_root/$api_repo" commit -m candidate >/dev/null
candidate_commit="$(git -C "$source_root/$api_repo" rev-parse HEAD)"
git -C "$source_root/$api_repo" push "$source_root/$api_repo.git" "$candidate_ref:$candidate_ref" >/dev/null
git -C "$source_root/$worker_repo" switch -c worker-candidate >/dev/null
printf '%s\n' worker-candidate-source-ok > "$source_root/$worker_repo/worker-candidate.txt"
git -C "$source_root/$worker_repo" add worker-candidate.txt
git -C "$source_root/$worker_repo" commit -m worker-candidate >/dev/null
worker_candidate_commit="$(git -C "$source_root/$worker_repo" rev-parse HEAD)"
git -C "$source_root/$worker_repo" push "$source_root/$worker_repo.git" \
  "$worker_candidate_ref:$worker_candidate_ref" >/dev/null

"$dim_bin" admin service ensure >/dev/null
source_credentials="$("$dim_bin" admin service credentials --show-secrets --json)"
export SOURCE_GIT_USERNAME
export SOURCE_GIT_TOKEN
SOURCE_GIT_USERNAME="$(printf '%s' "$source_credentials" | jq -r .adminUsername)"
SOURCE_GIT_TOKEN="$(printf '%s' "$source_credentials" | jq -r .adminPassword)"
source_git_base="http://127.0.0.1:${DIM_GITEA_PORT:-3300}/$source_namespace"
gitea_request POST \
  "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/orgs" \
  "$SOURCE_GIT_USERNAME" "$SOURCE_GIT_TOKEN" \
  "$(jq -n --arg name "$source_namespace" '{username:$name,visibility:"private"}')"

project_worktree="$source_root/root"
project_bare="$source_root/root.git"
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
  'test ! -e /tmp/dim-multi-setup-error' \
  > "$project_worktree/.dim/setup.sh"

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
  '  lifecycle-sentinel:' \
  '    image: alpine:3.22' \
  '    command: ["sleep", "infinity"]' \
  '  api-checkout:' \
  '    profiles: [development]' \
  '    image: alpine:3.22' \
  '    environment:' \
  '      REPO_URL: ${DIM_GIT_BASE_URL}/api.git' \
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
  '      REPO_URL: ${DIM_GIT_BASE_URL}/worker.git' \
  '    entrypoint: ["/bin/sh", "-c"]' \
  '    command: ["apk add --no-cache git >/dev/null && { test -d /source/.git || git clone $$REPO_URL /source; }"]' \
  '    volumes: [worker-source:/source]' \
  '  docs-checkout:' \
  '    profiles: [documentation]' \
  '    image: alpine:3.22' \
  '    environment:' \
  '      REPO_URL: ${DIM_GIT_BASE_URL}/docs.git' \
  '    entrypoint: ["/bin/sh", "-c"]' \
  '    command: ["apk add --no-cache git >/dev/null && { test -d /source/.git || git clone $$REPO_URL /source; }"]' \
  '    volumes: [docs-source:/source]' \
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
  '      docs-checkout: {condition: service_completed_successfully}' \
  '    entrypoint: ["/bin/sh", "-c"]' \
  '    command: ["test \"$$(cat /api/message.txt)\" = api-source-ok && test \"$$(cat /worker/message.txt)\" = worker-source-ok && test \"$$(cat /docs/message.txt)\" = docs-source-ok && echo multi-repo-project-ok"]' \
  '    volumes:' \
  '      - api-source:/api:ro' \
  '      - worker-source:/worker:ro' \
  '      - docs-source:/docs:ro' \
  'volumes:' \
  '  api-source:' \
  '  worker-source:' \
  '  docs-source:' \
  > "$project_worktree/.dim/docker-compose.yml"

printf '%s\n' v1 > "$project_worktree/version.txt"
jq -n \
  --arg root "$source_git_base/root" \
  --arg api "$source_git_base/$api_repo" \
  --arg worker "$source_git_base/$worker_repo" \
  --arg docs "$source_git_base/$docs_repo" \
  '{
    schemaVersion: 1,
    repositories: {
      atlas: {url: $root, root: true, ref: "main", protect: ["release/*"]},
      api: {url: $api},
      worker: {url: $worker},
      docs: {url: $docs}
    }
  }' > "$project_worktree/.dim/repos.yml"
git -C "$project_worktree" add .dim compose.yaml version.txt
git -C "$project_worktree" commit -m 'add DIM project environment' >/dev/null
git clone --bare "$project_worktree" "$project_bare" >/dev/null

source_helper='!f() { echo username=$SOURCE_GIT_USERNAME; echo password=$SOURCE_GIT_TOKEN; }; f'
for name in root "$api_repo" "$worker_repo" "$docs_repo"; do
  gitea_request POST \
    "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/orgs/$source_namespace/repos" \
    "$SOURCE_GIT_USERNAME" "$SOURCE_GIT_TOKEN" \
    "$(jq -n --arg name "$name" '{name:$name,private:true}')"
  git --git-dir "$source_root/$name.git" \
    -c credential.helper= \
    -c "credential.helper=$source_helper" \
    push "$source_git_base/$name" --all >/dev/null
done

export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0="$source_helper"
export GIT_TERMINAL_PROMPT=0

echo "[multi-repository] retry an interrupted root import with the same command"
retry_url="$source_root/retry.git"
if "$dim_bin" project create "$retry_project_name" --root root --bootstrap-git-url "$retry_url" >/dev/null 2>&1; then
  echo "missing root source unexpectedly imported" >&2
  exit 1
fi
create_repo retry "retry-source-ok"
"$dim_bin" project create "$retry_project_name" --root root --bootstrap-git-url "$retry_url" >/dev/null
test "$("$dim_bin" repo show "$retry_project_name" root --json | jq -r .phase)" = ready
"$dim_bin" project purge "$retry_project_name" --yes

echo "[multi-repository] custom bootstrap manifest does not replace the tracked root manifest"
custom_manifest="$source_root/custom-repos.yml"
jq '.repositories.atlas.protect = []' "$project_worktree/.dim/repos.yml" > "$custom_manifest"
"$dim_bin" project create "$custom_project_name" --repos "$custom_manifest" --yes >/dev/null
custom_clone="$source_root/custom-managed-root"
"$dim_bin" x git clone --quiet "$("$dim_bin" repo url "$custom_project_name" atlas)" "$custom_clone"
cmp "$project_worktree/.dim/repos.yml" "$custom_clone/.dim/repos.yml"
"$dim_bin" project purge "$custom_project_name" --yes

echo "[multi-repository] bootstrap from an authenticated private root URL and apply its manifest"
"$dim_bin" project create "$project_name" \
  --bootstrap-git-url "$source_git_base/root" \
  --bootstrap-git-ref main \
  --apply-repos \
  >/dev/null
test "$("$dim_bin" project show "$project_name" --json | jq -r .rootRepositoryAlias)" = atlas
root_url="$("$dim_bin" repo url "$project_name" atlas)"

if ! "$dim_bin" workspace create "$project_name" "$workspace_name" \
  --profile development \
  --profile documentation \
  --repo-ref "$api_repo=$candidate_ref" \
  --repo-ref "$worker_repo=$worker_candidate_ref" \
  >/dev/null; then
  echo "multi-repository workspace setup failed; managed state and Project service diagnostics:" >&2
  workspace_json="$("$dim_bin" workspace show "$workspace_name" --json 2>/dev/null || true)"
  if [[ -n "$workspace_json" ]]; then
    printf '%s\n' "$workspace_json" | jq '{name,phase,error,lastSetup,containerName,composeProjectName,profiles}' >&2
    failed_container="$(printf '%s' "$workspace_json" | jq -r .containerName)"
    failed_compose_project="$(printf '%s' "$workspace_json" | jq -r .composeProjectName)"
    docker exec "$failed_container" sh -lc \
      "cd /workspace/project && docker compose --project-name '$failed_compose_project' --file .dim/docker-compose.yml --profile '*' ps" >&2 || true
    docker exec "$failed_container" sh -lc \
      "cd /workspace/project && docker compose --project-name '$failed_compose_project' --file .dim/docker-compose.yml --profile '*' logs --no-color --tail 100" >&2 || true
  fi
  exit 1
fi

# Container names generated by the project's own Compose file follow
# COMPOSE_PROJECT_NAME, which `dim` documents and exports for exactly this
# purpose -- read it back from `show --json` rather than assuming a
# `dim-<name>`-shaped prefix here too.
workspace_json="$("$dim_bin" workspace show "$workspace_name" --json)"
compose_project_name="$(jq -r .composeProjectName <<<"$workspace_json")"

test "$(jq -c .profiles <<<"$workspace_json")" = '["development","documentation"]'
jq -e \
  --arg ref "$candidate_ref" \
  --arg commit "$candidate_commit" \
  --arg worker_ref "$worker_candidate_ref" \
  --arg worker_commit "$worker_candidate_commit" '
  .repositoryRefOverrides.api == $ref
  and .repositoryRefOverrides.worker == $worker_ref
  and .repositorySnapshot.api.requestedRef == $ref
  and .repositorySnapshot.api.ref == $ref
  and .repositorySnapshot.api.commit == $commit
  and .repositorySnapshot.worker.requestedRef == $worker_ref
  and .repositorySnapshot.worker.ref == $worker_ref
  and .repositorySnapshot.worker.commit == $worker_commit
' <<<"$workspace_json" >/dev/null
"$dim_bin" workspace exec "$workspace_name" -- jq -e \
  --arg ref "$candidate_ref" \
  --arg commit "$candidate_commit" \
  --arg worker_ref "$worker_candidate_ref" \
  --arg worker_commit "$worker_candidate_commit" '
    .repositories.api.requestedRef == $ref
    and .repositories.api.ref == $ref
    and .repositories.api.commit == $commit
    and .repositories.worker.requestedRef == $worker_ref
    and .repositories.worker.ref == $worker_ref
    and .repositories.worker.commit == $worker_commit
  ' /run/dim/project.json >/dev/null
test "$("$dim_bin" exec "$workspace_name" -- ls -1 /workspace)" = "project"
git ls-remote "$("$dim_bin" repo url "$project_name" api)" \
  "refs/heads/agent/$workspace_name" | grep -q .

output="$("$dim_bin" run "$workspace_name" verify)"
test "$output" = "multi-repo-project-ok"
test "$("$dim_bin" run "$workspace_name" version)" = "v1"

echo "[multi-repository] moved candidate ref does not change setup recovery snapshot"
printf '%s\n' moved-candidate-source-ok >> "$source_root/$api_repo/candidate.txt"
git -C "$source_root/$api_repo" add candidate.txt
git -C "$source_root/$api_repo" commit -m 'move candidate' >/dev/null
moved_candidate_commit="$(git -C "$source_root/$api_repo" rev-parse HEAD)"
test "$moved_candidate_commit" != "$candidate_commit"
"$dim_bin" x git -C "$source_root/$api_repo" push \
  "$("$dim_bin" repo url "$project_name" "$api_repo")" "$candidate_ref" >/dev/null
"$dim_bin" workspace exec "$workspace_name" -- touch /tmp/dim-multi-setup-error
if "$dim_bin" workspace setup "$workspace_name" >/dev/null 2>&1; then
  echo "injected multi-repository setup failure unexpectedly succeeded" >&2
  exit 1
fi
workspace_json="$("$dim_bin" workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = setup-error
test "$(jq -r .repositorySnapshot.api.commit <<<"$workspace_json")" = "$candidate_commit"
"$dim_bin" workspace exec "$workspace_name" -- rm /tmp/dim-multi-setup-error
"$dim_bin" workspace setup "$workspace_name" >/dev/null
test "$("$dim_bin" workspace show "$workspace_name" --json | jq -r .repositorySnapshot.api.commit)" = \
  "$candidate_commit"
test "$("$dim_bin" workspace exec "$workspace_name" -- \
  jq -r .repositories.api.commit /run/dim/project.json)" = "$candidate_commit"

echo "[multi-repository] invalid overrides reject without project, workspace, repository, or ref mutation"
assert_workspace_create_rejected \
  "the root repository ref cannot be overridden by a workspace candidate" \
  "$rejected_workspace_name" \
  --repo-ref "atlas=$candidate_ref"
assert_workspace_create_rejected \
  "project '$project_name' has no repository 'unknown'" \
  "$rejected_workspace_name" \
  --repo-ref "unknown=$candidate_ref"
assert_workspace_create_rejected \
  "repository ref override 'malformed' must use alias=ref" \
  "$rejected_workspace_name" \
  --repo-ref malformed
assert_workspace_create_rejected \
  "repository ref override '$api_repo' is duplicated" \
  "$rejected_workspace_name" \
  --repo-ref "$api_repo=$candidate_ref" --repo-ref "$api_repo=refs/heads/main"
unavailable_ref="refs/heads/unavailable-$suffix"
assert_workspace_create_rejected \
  "failed to resolve repository ref '$project_name/$api_repo:$unavailable_ref'" \
  "$rejected_workspace_name" \
  --repo-ref "$api_repo=$unavailable_ref"
assert_workspace_create_rejected \
  "workspace '$workspace_name' already exists with different repository ref overrides" \
  "$workspace_name" \
  --repo-ref "$api_repo=refs/heads/main"

echo "[multi-repository] dirty restart rejects before lifecycle mutation"
workspace_before="$("$dim_bin" workspace show "$workspace_name" --json)"
container_name="$(jq -r .containerName <<<"$workspace_before")"
sentinel_name="${compose_project_name}-lifecycle-sentinel-1"
outer_started_before="$(docker inspect --format '{{.State.StartedAt}}' "$container_name")"
sentinel_id_before="$("$dim_bin" workspace exec "$workspace_name" -- docker inspect --format '{{.Id}}' "$sentinel_name")"
sentinel_started_before="$("$dim_bin" workspace exec "$workspace_name" -- docker inspect --format '{{.State.StartedAt}}' "$sentinel_name")"
"$dim_bin" workspace exec "$workspace_name" -- sh -c \
  'printf "dirty\n" >> version.txt && printf "untracked\n" > restart-untracked.txt'
git_state_before="$("$dim_bin" workspace exec "$workspace_name" -- sh -c \
  'git rev-parse HEAD; git write-tree; git status --porcelain=v1; sha256sum version.txt restart-untracked.txt')"
if restart_error="$("$dim_bin" workspace restart "$workspace_name" 2>&1)"; then
  echo "dirty workspace restart unexpectedly succeeded" >&2
  exit 1
fi
grep -q "dim workspace align $workspace_name --reset --yes" <<<"$restart_error"
test "$("$dim_bin" workspace exec "$workspace_name" -- sh -c \
  'git rev-parse HEAD; git write-tree; git status --porcelain=v1; sha256sum version.txt restart-untracked.txt')" = \
  "$git_state_before"
test "$("$dim_bin" workspace show "$workspace_name" --json)" = "$workspace_before"
test "$(docker inspect --format '{{.State.Running}}|{{.State.StartedAt}}' "$container_name")" = \
  "true|$outer_started_before"
test "$("$dim_bin" workspace exec "$workspace_name" -- docker inspect \
  --format '{{.Id}}|{{.State.Running}}|{{.State.StartedAt}}' "$sentinel_name")" = \
  "$sentinel_id_before|true|$sentinel_started_before"
"$dim_bin" workspace exec "$workspace_name" -- sh -c \
  'git restore version.txt && rm restart-untracked.txt'

if "$dim_bin" exec "$workspace_name" -- \
  docker container inspect "${compose_project_name}-production-only-1" >/dev/null 2>&1; then
  echo "production-only profile unexpectedly ran" >&2
  exit 1
fi
if ! "$dim_bin" exec "$workspace_name" -- sh -c \
  'test -z "$(docker ps -aq --filter name=root-compose-must-be-ignored)"'; then
  echo "root compose file was unexpectedly discovered" >&2
  exit 1
fi

git -C "$project_worktree" remote add managed "$root_url"
printf '%s\n' v2 > "$project_worktree/version.txt"
git -C "$project_worktree" add version.txt
git -C "$project_worktree" commit -m 'update project version' >/dev/null
"$dim_bin" x git -C "$project_worktree" push managed main >/dev/null

test "$("$dim_bin" run "$workspace_name" version)" = "v1"
"$dim_bin" workspace restart "$workspace_name" >/dev/null
test "$("$dim_bin" run "$workspace_name" version)" = "v2"

"$dim_bin" workspace update "$workspace_name" --profile production >/dev/null
"$dim_bin" exec "$workspace_name" -- \
  docker container inspect "${compose_project_name}-production-only-1" >/dev/null

"$dim_bin" workspace update "$workspace_name" \
  --profile development \
  --profile documentation \
  >/dev/null
if "$dim_bin" exec "$workspace_name" -- \
  docker container inspect "${compose_project_name}-production-only-1" >/dev/null 2>&1; then
  echo "old production profile container remained after profile replacement" >&2
  exit 1
fi
output="$("$dim_bin" run "$workspace_name" verify)"
test "$output" = "multi-repo-project-ok"

find "$source_root" -depth -delete

"$dim_bin" workspace stop "$workspace_name" >/dev/null
"$dim_bin" workspace start "$workspace_name" >/dev/null
output="$("$dim_bin" run "$workspace_name" verify)"
test "$output" = "multi-repo-project-ok"

echo "[multi-repository] non-ready repository rejects without project, workspace, repository, or ref mutation"
if "$dim_bin" repo add "$project_name" broken "$source_root/missing.git" >/dev/null 2>&1; then
  echo "missing non-root source unexpectedly imported" >&2
  exit 1
fi
test "$("$dim_bin" repo show "$project_name" broken --json | jq -r .phase)" = error
assert_workspace_create_rejected \
  "project '$project_name' repository 'broken' is not ready (phase: error)" \
  "$rejected_workspace_name" \
  --repo-ref "$api_repo=$candidate_ref"

"$dim_bin" workspace discard "$workspace_name" --yes >/dev/null

echo "container-multi-repo-project-smoke-ok"
