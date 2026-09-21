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
cd "$repo_root"
DIM_EXAMPLES_ROOT="$repo_root/examples" \
  bash "$script_dir/two-repository-policy-smoke.bash"
DIM_EXAMPLES_ROOT="$repo_root/examples" \
  bash "$script_dir/two-repository-materialization-smoke.bash"
workspace_backend="${DIM_EXAMPLE_WORKSPACE_BACKEND:-sysbox}"
local_version="$(bash "$script_dir/local-build-version.bash")"
workspace_image="dev-infra-project-workspace:$local_version"
export DIM_WORKSPACE_IMAGE="$workspace_image"
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

echo "[two-repository] install DIM and materialize root plus app"
dim_install_example_cli "$repo_root" "$work_dir" "$install_prefix"
docker build \
  --quiet \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag "$workspace_image" \
  --file "$repo_root/core/images/project-workspace/Dockerfile" \
  "$repo_root" >/dev/null
bash "$repo_root/examples/projects/two-repository/create-repositories.bash" \
  "$source_root" >/dev/null

test -d "$source_root/root/.git"
test -d "$source_root/app/.git"
test -f "$source_root/root/.dim/repos.yml"
test ! -e "$source_root/app/.dim"
app_commit="$(git -C "$source_root/app" rev-parse HEAD)"

echo "[two-repository] register exactly the root and app aliases"
DIM_BIN="$dim_bin" bash \
  "$repo_root/examples/projects/two-repository/register-project.bash" \
  "$project_name" "$source_root" >/dev/null
test "$(dim repo list "$project_name" --json | jq -r 'map(.alias) | sort | join(",")')" = \
  "app,root"
repositories_json="$(dim repo list "$project_name" --json)"
jq -e '
  (map(select(.alias == "root"))[0].protectedPatterns == ["main"]) and
  (map(select(.alias == "app"))[0].protectedPatterns == [])
' <<<"$repositories_json" >/dev/null

echo "[two-repository] enforce protection only on root main"
printf '\n' >>"$source_root/root/.dim/repos.yml"
git -C "$source_root/root" commit -am "attempted direct root push" >/dev/null
if dim x git -C "$source_root/root" push \
  "$(dim repo url "$project_name" root)" main >/dev/null 2>&1; then
  echo "protected root main unexpectedly accepted a direct push" >&2
  exit 1
fi
rm -rf "$source_root"

echo "[two-repository] create the workspace and run an app command"
dim workspace create "$project_name" "$workspace_name" >/dev/null
workspace_json="$(dim workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = "ready"
container_name="$(jq -r .containerName <<<"$workspace_json")"
project_path="$(jq -r .projectPath <<<"$workspace_json")"
test "$(jq -r .repositorySnapshot.app.requestedRef <<<"$workspace_json")" = main
test "$(jq -r .repositorySnapshot.app.ref <<<"$workspace_json")" = refs/heads/main
test "$(jq -r .repositorySnapshot.app.commit <<<"$workspace_json")" = "$app_commit"
test "$(docker inspect "$container_name" --format '{{.Config.Image}}')" = "$workspace_image"

app_container="$(dim workspace exec "$workspace_name" -- \
  docker compose --file .dim/docker-compose.yml ps --quiet app)"
test -n "$app_container"
test "$(dim workspace exec "$workspace_name" -- docker inspect "$app_container" \
  --format '{{.Config.User}}')" = "$(id -u):$(id -g)"
test "$(dim workspace exec "$workspace_name" -- docker inspect "$app_container" \
  --format '{{json .HostConfig.CapDrop}}')" = '["ALL"]'
dim workspace exec "$workspace_name" -- docker inspect "$app_container" \
  --format '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges'
dim workspace exec "$workspace_name" -- docker inspect "$app_container" \
  --format '{{.HostConfig.Privileged}}' | grep -qx false
mounts_json="$(dim workspace exec "$workspace_name" -- docker inspect "$app_container" \
  --format '{{json .Mounts}}')"
jq -e --arg app "$project_path/app" '
  length == 2 and
  any(.[]; .Destination == "/workspace" and .Type == "bind" and .RW == true and .Source == $app) and
  any(.[]; .Destination == "/home/dim-agent" and .Type == "volume" and .RW == true) and
  all(.[]; (.Destination == "/workspace" or .Destination == "/home/dim-agent"))
' <<<"$mounts_json" >/dev/null

test "$(dim workspace run "$workspace_name" app -- id -u)" -ne 0
dim workspace run "$workspace_name" app -- sh -eu -c '
  test "$PWD" = /workspace
  test ! -e /workspace/.dim
  test ! -e /var/run/docker.sock
  test ! -e /run/dim/controller
  test ! -e /run/dim/controller-proxy
  test ! -e /dev/kvm
  ! command -v sudo >/dev/null 2>&1
  ! command -v docker >/dev/null 2>&1
  test -z "${DIM_CONTROLLER_SOCKET:-}"
  test -z "${DIM_CONTROLLER_TOKEN:-}"
  test -z "${DOCKER_HOST:-}"
'
test "$(dim workspace run "$workspace_name" app -- git rev-parse HEAD)" = "$app_commit"
test "$(dim workspace run "$workspace_name" app -- git branch --show-current)" = main
test "$(dim workspace run "$workspace_name" app -- sh hello.bash)" = \
  "hello from the ordinary app repository"
test "$(dim workspace run "$workspace_name" app -- sh -c \
  'printf "%s|%s" "$1" "$2"' sh 'argument with spaces' '*.txt')" = \
  'argument with spaces|*.txt'
stderr_file="$work_dir/app.stderr"
set +e
dim workspace run "$workspace_name" app -- sh -c \
  'printf stdout-value; printf stderr-value >&2; exit 37' \
  >"$work_dir/app.stdout" 2>"$stderr_file"
app_status=$?
set -e
test "$app_status" -eq 37
test "$(cat "$work_dir/app.stdout")" = stdout-value
test "$(cat "$stderr_file")" = stderr-value
dim workspace run "$workspace_name" app -- sh -c \
  'printf "survived\n" >.restart-marker'
dim workspace run "$workspace_name" app -- sh -c \
  'printf "home-survived\n" >"$HOME/.restart-marker"'

echo "[two-repository] preserve the app checkout across restart"
dim workspace restart "$workspace_name" >/dev/null
test "$(dim workspace run "$workspace_name" app -- sh hello.bash)" = \
  "hello from the ordinary app repository"
test "$(dim workspace run "$workspace_name" app -- cat .restart-marker)" = "survived"
test "$(dim workspace run "$workspace_name" app -- cat /home/dim-agent/.restart-marker)" = \
  "home-survived"
test "$(dim workspace run "$workspace_name" app -- git rev-parse HEAD)" = "$app_commit"

echo "[two-repository] discard the workspace explicitly"
dim workspace discard "$workspace_name" --yes >/dev/null
test ! -e "$state_root/workspaces/$workspace_name.json"
! docker container inspect "$container_name" >/dev/null 2>&1

echo "two-repository-example-smoke-ok"
