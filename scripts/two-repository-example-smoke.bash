#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
# shellcheck source=lib/local-npm-registry.bash
source "$script_dir/lib/local-npm-registry.bash"
# shellcheck source=lib/example-dim-install.bash
source "$script_dir/lib/example-dim-install.bash"

suffix="$PPID-$$"
project_name="two-repository-$suffix"
workspace_name="two-repository-dev-$suffix"
work_dir="$(mktemp -d /tmp/dim-two-repository.XXXXXX)"
state_root="$work_dir/state"
source_root="$work_dir/source"
install_prefix="$work_dir/install"
dim_bin="$install_prefix/bin/dim"

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
export DIM_DATA_HOME="$work_dir/data"
export GIT_CONFIG_GLOBAL="$work_dir/host.gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Two Repository Developer"
git config --file "$GIT_CONFIG_GLOBAL" user.email "developer@dim.invalid"
workspace_backend="${DIM_EXAMPLE_WORKSPACE_BACKEND:-sysbox}"
bash "$script_dir/configure-user-backend.bash" "$workspace_backend"

dim() { "$dim_bin" "$@"; }

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    dim workspace discard "$workspace_name" --yes >/dev/null 2>&1 || true
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
  dim_stop_local_npm_registry
  rm -rf "$work_dir"
}
trap cleanup EXIT

cd "$repo_root"
echo "[two-repository] install DIM and materialize root plus app"
dim_install_example_cli "$repo_root" "$work_dir" "$install_prefix"
docker build \
  --quiet \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag dev-infra-project-workspace:latest \
  --file "$repo_root/core/images/project-workspace/Dockerfile" \
  "$repo_root" >/dev/null
bash "$repo_root/examples/projects/two-repository/create-repositories.bash" \
  "$source_root" >/dev/null

test -d "$source_root/root/.git"
test -d "$source_root/app/.git"
test -f "$source_root/root/.dim/repos.yml"
test ! -e "$source_root/app/.dim"

echo "[two-repository] register exactly the root and app aliases"
DIM_BIN="$dim_bin" bash \
  "$repo_root/examples/projects/two-repository/register-project.bash" \
  "$project_name" "$source_root" >/dev/null
test "$(dim repo list "$project_name" --json | jq -r 'map(.alias) | sort | join(",")')" = \
  "app,root"
rm -rf "$source_root"

echo "[two-repository] create the workspace and run an app command"
dim workspace create "$project_name" "$workspace_name" >/dev/null
workspace_json="$(dim workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = "ready"
container_name="$(jq -r .containerName <<<"$workspace_json")"
test "$(dim workspace run "$workspace_name" app -- sh hello.bash)" = \
  "hello from the ordinary app repository"
dim workspace run "$workspace_name" app -- sh -c \
  'printf "survived\n" >.restart-marker'

echo "[two-repository] preserve the app checkout across restart"
dim workspace restart "$workspace_name" >/dev/null
test "$(dim workspace run "$workspace_name" app -- sh hello.bash)" = \
  "hello from the ordinary app repository"
test "$(dim workspace run "$workspace_name" app -- cat .restart-marker)" = "survived"

echo "[two-repository] discard the workspace explicitly"
dim workspace discard "$workspace_name" --yes >/dev/null
test ! -e "$state_root/workspaces/$workspace_name.json"
! docker container inspect "$container_name" >/dev/null 2>&1

echo "two-repository-example-smoke-ok"
