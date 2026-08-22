#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
# shellcheck source=lib/test-registry-mirror.bash
source "$script_dir/lib/test-registry-mirror.bash"

suffix="$PPID-$$"
project_name="full-flow-$suffix"
workspace_name="full-flow-dev-$suffix"
work_dir="$(mktemp -d /tmp/dim-full-development-flow.XXXXXX)"
repositories="$work_dir/repositories"
state_root="$work_dir/state"
controller_dir="$work_dir/controller"
controller_socket="$controller_dir/controller.sock"
admin_socket="$controller_dir/admin.sock"
backup="$work_dir/agent-home.tar.gz"
dim_cli="$repo_root/packages/cli/dist/cli.js"
dim_bin="$work_dir/dim"
controller_pid=""

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
export DIM_DATA_HOME="$work_dir/data"
export DIM_CONTROLLER_SOCKET="$controller_socket"
export DIM_ADMIN_CONTROLLER_SOCKET="$admin_socket"
export GIT_CONFIG_GLOBAL="$work_dir/host.gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Full Flow Host"
git config --file "$GIT_CONFIG_GLOBAL" user.email "full-flow@dim.invalid"

dim() { node "$dim_cli" "$@"; }

stop_controller() {
  if [[ -n "$controller_pid" ]]; then
    kill "$controller_pid" >/dev/null 2>&1 || true
    wait "$controller_pid" >/dev/null 2>&1 || true
    controller_pid=""
  fi
}

start_controller() {
  mkdir -p "$controller_dir"
  dim controller serve --socket "$controller_socket" --admin-socket "$admin_socket" \
    >"$controller_dir/controller.log" 2>&1 &
  controller_pid=$!
  for attempt in $(seq 1 60); do
    [[ -S "$controller_socket" && -S "$admin_socket" ]] && return
    if ! kill -0 "$controller_pid" >/dev/null 2>&1; then
      cat "$controller_dir/controller.log" >&2
      return 1
    fi
    [[ "$attempt" -lt 60 ]] || { cat "$controller_dir/controller.log" >&2; return 1; }
    sleep 1
  done
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    dim workspace discard "$workspace_name" --yes >/dev/null 2>&1 || status=1
  fi
  if [[ -f "$state_root/projects/$project_name.json" ]]; then
    dim project purge "$project_name" --yes >/dev/null 2>&1 || status=1
  fi
  stop_controller
  find "$work_dir" -depth -delete 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

cd "$repo_root"
echo "[full-development-flow] prepare reviewed repositories and controller"
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$dim_cli" >"$dim_bin"
chmod 0700 "$dim_bin"
bash "$script_dir/configure-user-backend.bash" "${DIM_EXAMPLE_WORKSPACE_BACKEND:-runc}"
bash examples/projects/full-development-flow/create-repositories.bash "$repositories" >/dev/null
dim_apply_test_registry_mirror "$repositories/root"
mv "$repositories/root/.dim/setup.sh" "$repositories/root/.dim/setup-real.sh"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'set -eu' \
  'if test -e /tmp/dim-stateful-setup-error; then' \
  '  echo "intentional stateful journey setup failure" >&2' \
  '  exit 42' \
  'fi' \
  'exec sh .dim/setup-real.sh "$@"' \
  >"$repositories/root/.dim/setup.sh"
git -C "$repositories/root" add .dim
git -C "$repositories/root" commit -m "add stateful journey hooks" >/dev/null

docker build --quiet \
  --build-arg "DIM_UID=$(id -u)" --build-arg "DIM_GID=$(id -g)" \
  --tag dev-infra-project-workspace:latest \
  --file images/project-workspace/Dockerfile . >/dev/null
start_controller
DIM_BIN="$dim_bin" bash examples/projects/full-development-flow/register-project.bash \
  "$project_name" "$repositories" >/dev/null

echo "[full-development-flow] create a profiled, resource-bounded workspace"
if ! dim workspace create "$project_name" "$workspace_name" \
  --profile documentation --cpus 2 --memory 3g --processes 768 >/dev/null; then
  failed_workspace="$(dim workspace show "$workspace_name" --json)"
  failed_container="$(jq -r .containerName <<<"$failed_workspace")"
  failed_project_path="$(jq -r .projectPath <<<"$failed_workspace")"
  failed_compose=(--file .dim/docker-compose.yml)
  if [[ -f "$failed_project_path/.dim/ci-registry-mirror.override.yml" ]]; then
    failed_compose+=(--file .dim/ci-registry-mirror.override.yml)
  fi
  docker start "$failed_container" >/dev/null 2>&1 || true
  docker exec --user dim "$failed_container" \
    sh -c 'cat /tmp/dim-agent-controller/agent.log 2>/dev/null || true' >&2 || true
  docker exec --user dim --workdir "$failed_project_path" "$failed_container" \
    docker compose --project-name "dim-$workspace_name" \
    "${failed_compose[@]}" ps --all >&2 || true
  docker exec --user dim --workdir "$failed_project_path" "$failed_container" \
    docker compose --project-name "dim-$workspace_name" \
    "${failed_compose[@]}" logs >&2 || true
  exit 1
fi
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -r .containerName <<<"$workspace_json")"
compose_name="$(jq -r .composeProjectName <<<"$workspace_json")"
test "$(jq -c .profiles <<<"$workspace_json")" = '["documentation"]'
test "$(jq -r .cpuCount <<<"$workspace_json")" = 2
test "$(jq -r .memory <<<"$workspace_json")" = 3g
test "$(jq -r .pidsLimit <<<"$workspace_json")" = 768
dim workspace exec "$workspace_name" -- docker inspect \
  "${compose_name}-documentation-preview-1" >/dev/null
dim workspace run "$workspace_name" bash -- -lc \
  'docker info --format "{{json .SecurityOptions}}" | grep -q rootless; docker run --rm hello-world >/dev/null'

echo "[full-development-flow] preserve work across dirty rejection and reviewed restart"
dim workspace run "$workspace_name" bash -- -lc \
  'printf "persistent-home\n" >"$HOME/journey-home"'
before="$(dim workspace show "$workspace_name" --json)"
started_before="$(docker inspect --format '{{.State.StartedAt}}' "$container_name")"
dim workspace exec "$workspace_name" -- sh -c \
  'printf "dirty\n" >>README.md; printf "untracked\n" >journey-untracked'
if restart_error="$(dim workspace restart "$workspace_name" 2>&1)"; then
  echo "dirty workspace restart unexpectedly succeeded" >&2
  exit 1
fi
grep -q "dim workspace align $workspace_name --reset --yes" <<<"$restart_error"
test "$(dim workspace show "$workspace_name" --json)" = "$before"
test "$(docker inspect --format '{{.State.StartedAt}}' "$container_name")" = "$started_before"
dim workspace exec "$workspace_name" -- sh -c \
  'git restore README.md; rm journey-untracked'

review="$work_dir/review"
dim x git clone --quiet "$(dim repo url "$project_name" root)" "$review"
git -C "$review" config user.name "Full Flow Reviewer"
git -C "$review" config user.email "reviewer@dim.invalid"
printf 'reviewed-v2\n' >"$review/reviewed-version.txt"
git -C "$review" add reviewed-version.txt
git -C "$review" commit -m "review development environment update" >/dev/null
dim x git -C "$review" push origin main >/dev/null
dim workspace restart "$workspace_name" >/dev/null
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat reviewed-version.txt')" = reviewed-v2
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home

echo "[full-development-flow] survive stop/start and controller replacement"
dim workspace stop "$workspace_name" >/dev/null
dim workspace start "$workspace_name" >/dev/null
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home
stop_controller
start_controller
controller_discovery="$(dim workspace run "$workspace_name" bash -- -lc \
  'curl --fail --silent --unix-socket "$DIM_CONTROLLER_SOCKET" http://dim-controller/api')"
test "$(jq -r '.routes[0] | "\(.method) \(.path)"' <<<"$controller_discovery")" = \
  'POST /api/workspace/restart'

echo "[full-development-flow] recover from setup-error"
dim workspace exec "$workspace_name" -- touch /tmp/dim-stateful-setup-error
if dim workspace setup "$workspace_name" >/dev/null 2>&1; then
  echo "injected setup failure unexpectedly succeeded" >&2
  exit 1
fi
test "$(dim workspace show "$workspace_name" --json | jq -r .phase)" = setup-error
dim workspace exec "$workspace_name" -- rm /tmp/dim-stateful-setup-error
dim workspace setup "$workspace_name" >/dev/null
test "$(dim workspace show "$workspace_name" --json | jq -r .phase)" = ready

echo "[full-development-flow] backup, discard, recreate, and restore agent home"
dim workspace run "$workspace_name" backup >"$backup"
gzip -t "$backup"
dim workspace discard "$workspace_name" --yes >/dev/null
test ! -e "$state_root/workspaces/$workspace_name.json"
test -z "$(docker ps -aq --filter "name=^/dim-ws-$workspace_name$")"
test -z "$(docker volume ls -q --filter "name=^dim-ws-$workspace_name-docker$")"

dim workspace create "$project_name" "$workspace_name" \
  --profile documentation --cpus 2 --memory 3g --processes 768 >/dev/null
dim workspace run "$workspace_name" restore <"$backup"
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat reviewed-version.txt')" = reviewed-v2
dim workspace discard "$workspace_name" --yes >/dev/null
test ! -e "$state_root/workspaces/$workspace_name.json"
test -z "$(docker ps -aq --filter "name=^/dim-ws-$workspace_name$")"

dim project purge "$project_name" --yes >/dev/null
test ! -e "$state_root/projects/$project_name.json"
echo "stateful-development-flow-smoke-ok"
