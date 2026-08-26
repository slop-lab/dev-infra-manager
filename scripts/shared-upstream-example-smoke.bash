#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
suffix="$PPID-$$"
project_name="shared-upstream-$suffix"
work_dir="$(mktemp -d /tmp/dim-shared-upstream-example.XXXXXX)"
materialized="$work_dir/materialized"
state_root="$work_dir/state"
dim_cli="$repo_root/core/packages/cli/dist/cli.js"
dim_bin="$work_dir/dim"

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
export DIM_DATA_HOME="$work_dir/data"
export GIT_CONFIG_GLOBAL="$work_dir/host.gitconfig"
export DIM_CONTROLLER_SOCKET="$state_root/controller/controller.sock"
export DIM_ADMIN_CONTROLLER_SOCKET="$state_root/controller/admin.sock"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Shared Upstream Example"
git config --file "$GIT_CONFIG_GLOBAL" user.email "shared-upstream@dim.invalid"
bash "$script_dir/configure-user-backend.bash" "${DIM_EXAMPLE_WORKSPACE_BACKEND:-sysbox}"

dim() { node "$dim_cli" "$@"; }
cleanup() {
  if docker container inspect dim-gitea >/dev/null 2>&1; then
    local credentials username password
    credentials="$(docker exec dim-gitea cat /data/dim/credentials.json 2>/dev/null || true)"
    username="$(jq -r .adminUsername <<<"$credentials")"
    password="$(jq -r .adminPassword <<<"$credentials")"
    curl --fail --silent --user "$username:$password" --request DELETE \
      "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/orgs/dim-$project_name" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

cd "$repo_root"
echo "[shared-upstream-example] 1. build DIM packages"
pnpm run workspace:build >/dev/null
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$dim_cli" >"$dim_bin"
chmod 0700 "$dim_bin"

echo "[shared-upstream-example] 2. materialize one upstream and register two repositories"
bash examples/features/shared-upstream/create-repository.bash "$materialized" >/dev/null
DIM_BIN="$dim_bin" bash examples/features/shared-upstream/register-project.bash \
  "$project_name" "$materialized" >/dev/null

upstream="$materialized/upstream.git"
root_source="$materialized/repositories/root"
api_source="$materialized/repositories/api"
root_sha="$(git -C "$root_source" rev-parse main)"
api_sha="$(git -C "$api_source" rev-parse main)"
test "$(dim x git ls-remote "$(dim repo url "$project_name" root)" refs/heads/main | cut -f1)" = "$root_sha"
test "$(dim x git ls-remote "$(dim repo url "$project_name" api)" refs/heads/main | cut -f1)" = "$api_sha"
test "$(dim x git ls-remote "$(dim repo url "$project_name" root)" refs/tags/root-v1 | cut -f1)" = "$root_sha"
test "$(dim x git ls-remote "$(dim repo url "$project_name" api)" refs/tags/v1 | cut -f1)" = "$api_sha"
test -z "$(dim x git ls-remote "$(dim repo url "$project_name" root)" refs/tags/api/v1)"
test -z "$(dim x git ls-remote "$(dim repo url "$project_name" api)" refs/tags/root-v1)"

echo "[shared-upstream-example] 3. push a logical API ref through its namespace"
git -C "$api_source" switch -c feature >/dev/null
printf 'feature\n' >>"$api_source/api.txt"
git -C "$api_source" commit -am "add API feature" >/dev/null
feature_sha="$(git -C "$api_source" rev-parse HEAD)"
dim x git -C "$api_source" push "$(dim repo url "$project_name" api)" \
  feature:refs/heads/feature >/dev/null
dim repo publish "$project_name" >/dev/null
test "$(git ls-remote "$upstream" refs/heads/api/feature | cut -f1)" = "$feature_sha"
test -z "$(git ls-remote "$upstream" refs/heads/feature)"

echo "[shared-upstream-example] 4. fetch only refs owned by each repository"
git -C "$api_source" switch -c review main >/dev/null
printf 'review\n' >>"$api_source/api.txt"
git -C "$api_source" commit -am "add API review" >/dev/null
api_review_sha="$(git -C "$api_source" rev-parse HEAD)"
git -C "$api_source" push "$upstream" review:refs/heads/api/review >/dev/null
git -C "$root_source" switch -c root-review main >/dev/null
printf 'root review\n' >>"$root_source/README.md"
git -C "$root_source" commit -am "add root review" >/dev/null
root_review_sha="$(git -C "$root_source" rev-parse HEAD)"
git -C "$root_source" push "$upstream" root-review:refs/heads/root-review >/dev/null

dim repo fetch "$project_name" root --prune >/dev/null
dim repo fetch "$project_name" api --prune >/dev/null
test "$(dim x git ls-remote "$(dim repo url "$project_name" root)" refs/heads/upstream/root-review | cut -f1)" = "$root_review_sha"
test -z "$(dim x git ls-remote "$(dim repo url "$project_name" root)" refs/heads/upstream/api/review)"
test "$(dim x git ls-remote "$(dim repo url "$project_name" api)" refs/heads/upstream/review | cut -f1)" = "$api_review_sha"
test -z "$(dim x git ls-remote "$(dim repo url "$project_name" api)" refs/heads/upstream/root-review)"
test -z "$(dim x git ls-remote "$(dim repo url "$project_name" root)" refs/tags/api/feature-v1)"
test -z "$(dim x git ls-remote "$(dim repo url "$project_name" api)" refs/tags/root-v1)"

echo "shared-upstream-example-smoke-ok"
