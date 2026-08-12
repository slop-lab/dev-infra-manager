#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
# shellcheck source=lib/local-npm-registry.bash
source "$script_dir/lib/local-npm-registry.bash"
# shellcheck source=lib/example-dim-install.bash
source "$script_dir/lib/example-dim-install.bash"

suffix="$PPID-$$"
project_name="single-$suffix"
workspace_name="single-dev-$suffix"
work_dir="$(mktemp -d /tmp/dim-single-repository.XXXXXX)"
state_root="$work_dir/state"
source_root="$work_dir/source"
install_prefix="$work_dir/install"
dim_bin="$install_prefix/bin/dim"

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
export DIM_DATA_HOME="$work_dir/data"
export GIT_CONFIG_GLOBAL="$work_dir/host.gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Single Repository Agent"
git config --file "$GIT_CONFIG_GLOBAL" user.email "agent@dim.invalid"
workspace_backend="${DIM_EXAMPLE_WORKSPACE_BACKEND:-runc}"
bash "$script_dir/configure-user-backend.bash" "$workspace_backend"

dim() { "$dim_bin" "$@"; }

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    dim discard "$workspace_name" --yes >/dev/null 2>&1 || true
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
echo "[single-repository] install DIM and materialize one repository"
dim_install_example_cli "$repo_root" "$work_dir" "$install_prefix"
docker build \
  --quiet \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag dev-infra-project-workspace:latest \
  --file "$repo_root/images/project-workspace/Dockerfile" \
  "$repo_root" >/dev/null
bash "$repo_root/examples/projects/single-repository/create-repository.bash" \
  "$source_root" >/dev/null

echo "[single-repository] register without .dim/repos.yml or branch protection"
DIM_BIN="$dim_bin" bash \
  "$repo_root/examples/projects/single-repository/register-project.bash" \
  "$project_name" "$source_root" >/dev/null
test "$(dim repo list "$project_name" --json | jq 'length')" = "1"
test ! -e "$source_root/app/.dim/repos.yml"

rm -rf "$source_root"

echo "[single-repository] create a resource-bounded persistent workspace"
if ! dim create "$project_name" "$workspace_name" \
  --cpus 2 --memory 2g --pids-limit 512 >/dev/null; then
  dim exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml ps --all >&2 || true
  dim exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml logs agent agent-dind >&2 || true
  exit 1
fi
workspace_json="$(dim show "$workspace_name" --json)"
test "$(jq -r .cpuCount <<<"$workspace_json")" = "2"
test "$(jq -r .memory <<<"$workspace_json")" = "2g"
test "$(jq -r .pidsLimit <<<"$workspace_json")" = "512"
test "$(dim run "$workspace_name" bash -- -lc 'curl --fail --silent http://127.0.0.1:3000')" = \
  "hello from a single-repository DIM workspace"

agent_container="$(dim exec "$workspace_name" -- \
  docker compose --project-name "dim-$workspace_name" \
  --file .dim/docker-compose.yml ps --quiet agent)"
test -n "$agent_container"
dim exec "$workspace_name" -- docker inspect "$agent_container" \
  --format '{{.HostConfig.Privileged}}' | grep -qx false
! dim exec "$workspace_name" -- docker inspect "$agent_container" \
  --format '{{json .Mounts}}' | grep -q /var/run/docker.sock
dind_container="$(dim exec "$workspace_name" -- \
  docker compose --project-name "dim-$workspace_name" \
  --file .dim/docker-compose.yml ps --quiet agent-dind)"
test -n "$dind_container"
dim exec "$workspace_name" -- docker inspect "$dind_container" \
  --format '{{.HostConfig.Privileged}}' | grep -qx true
dim run "$workspace_name" bash -- -lc '
  docker info --format "{{json .SecurityOptions}}" | grep -q rootless
  docker run --rm hello-world
' >/dev/null

echo "[single-repository] push main directly from the no-secret workspace"
dim run "$workspace_name" bash -- -lc '
  printf "\nagent update\n" >>README.md
  git add README.md
  git commit -m "agent updates main" >/dev/null
  git push origin main >/dev/null
'

dim discard "$workspace_name" --yes >/dev/null
echo "single-repository-example-smoke-ok"
