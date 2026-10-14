#!/usr/bin/env bash

dim_stateful_initialize_work_tree() {
  local checkout_root="$1" configured_root
  configured_root="${DIM_EXAMPLE_WORK_ROOT:-$checkout_root/.local/dim-example-work}"
  mkdir -p "$configured_root"
  stateful_shared_work_root="$(realpath -- "$configured_root")"
  work_dir="$(mktemp -d "$stateful_shared_work_root/dim-full-development-flow.XXXXXX")"
  repositories="$work_dir/repositories"
  state_root="$work_dir/state"
  controller_runtime_dir="$(mktemp -d /tmp/dim-full-development-runtime.XXXXXX)"
  controller_dir="$controller_runtime_dir/controller"
  controller_socket="$controller_dir/controller.sock"
  agent_controller_socket="$controller_dir/agent.sock"
  admin_socket="$controller_dir/admin.sock"
  stateful_sibling_bind_sources=(
    "$state_root/assets/project-roots"
    "$controller_dir"
    "$controller_dir"
  )
}

dim_stateful_assert_shared_paths() {
  local source resolved_source
  for source in "$repositories" "$state_root" "${stateful_sibling_bind_sources[0]}"; do
    resolved_source="$(realpath --canonicalize-missing -- "$source")"
    case "$resolved_source" in
      "$stateful_shared_work_root"|"$stateful_shared_work_root"/*) ;;
      *)
        echo "bind source escapes shared work root: $resolved_source" >&2
        return 1
        ;;
    esac
  done
  for source in "$controller_runtime_dir" "${stateful_sibling_bind_sources[@]:1}"; do
    resolved_source="$(realpath --canonicalize-missing -- "$source")"
    case "$resolved_source" in
      "$controller_runtime_dir"|"$controller_runtime_dir"/*) ;;
      *)
        echo "bind source escapes controller runtime root: $resolved_source" >&2
        return 1
        ;;
    esac
  done
}

install_stateful_setup_hook() {
  mv "$repositories/root/.dim/setup.sh" "$repositories/root/.dim/setup-real.sh"
  printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    'if test -e /tmp/dim-stateful-setup-error; then' \
    '  rm -f /tmp/dim-stateful-setup-error' \
    '  echo "intentional stateful journey setup failure" >&2' \
    '  exit 42' \
    'fi' \
    'if sh .dim/setup-real.sh "$@" >/tmp/dim-stateful-setup.log 2>&1; then' \
    '  cat /tmp/dim-stateful-setup.log' \
    'else' \
    '  status=$?' \
    '  cat /tmp/dim-stateful-setup.log >&2' \
    '  exit "$status"' \
    'fi' \
    >"$repositories/root/.dim/setup.sh"
}

stop_start_workspace() {
  dim workspace stop "$workspace_name" >/dev/null
  dim workspace start "$workspace_name" >/dev/null
  test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home
}

restart_externally_stopped_workspace() {
  docker stop "$container_name" >/dev/null
  test "$(dim workspace show "$workspace_name" --json | jq -r .phase)" = stopped
  dim workspace restart "$workspace_name" >/dev/null
  test "$(dim workspace show "$workspace_name" --json | jq -r .phase)" = ready
  test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home
}

replace_controller() {
  local controller_discovery
  stop_controller
  start_controller
  controller_discovery="$(dim workspace run "$workspace_name" bash -- -lc \
    'curl --fail --silent --unix-socket "$DIM_CONTROLLER_SOCKET" http://dim-controller/api')"
  test "$(jq -r '.routes[0] | "\(.method) \(.path)"' <<<"$controller_discovery")" = \
    'POST /api/workspace/restart'
}

assert_host_stopped() {
  local volumes_before="$1"
  test "$(dim host status --json | jq -r .phase)" = stopped
  test "$(docker inspect --format '{{.State.Running}}' "$container_name")" = false
  test "$(docker volume ls --filter label=dim.managed=true --format '{{.Name}}' | sort)" = "$volumes_before"
  if dim workspace show "$workspace_name" >/dev/null 2>&1; then
    echo "workspace operations remained available while the DIM host was stopped" >&2
    return 1
  fi
}

assert_host_restored() {
  test "$(dim host status --json | jq -r .phase)" = ready
  test "$(jq -c .resumeWorkspaces "$state_root/host.json")" = '[]'
  test "$(jq -c .restartCiRunners "$state_root/host.json")" = '[]'
  test "$(jq -c .resumeManagedContainers "$state_root/host.json")" = '[]'
  test "$(dim workspace show "$workspace_name" --json | jq -r .phase)" = ready
  test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home
  test -n "$(dim project list --json | jq -r '.[0].name')"
}

recover_setup_error() {
  dim workspace exec "$workspace_name" -- touch /tmp/dim-stateful-setup-error
  if dim workspace setup "$workspace_name" >/dev/null 2>&1; then
    echo "injected setup failure unexpectedly succeeded" >&2
    return 1
  fi
  test "$(dim workspace show "$workspace_name" --json | jq -r .phase)" = setup-error
  dim workspace setup "$workspace_name" >/dev/null
  test "$(dim workspace show "$workspace_name" --json | jq -r .phase)" = ready
}

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

diagnose_workspace_setup() {
  local failed_workspace failed_container_name failed_container failed_workspace_data
  local failed_project_manifest failed_profiles failed_ids failed_uid failed_gid failed_project_path failed_action
  local -a failed_compose
  failed_workspace="$(dim workspace show "$workspace_name" --json)" || return 0
  failed_container_name="$(jq -er .containerName <<<"$failed_workspace")" || return 0
  failed_workspace_data="$(jq -er .workspaceDataPath <<<"$failed_workspace")" || return 0
  failed_project_manifest="$(jq -er .projectManifestPath <<<"$failed_workspace")" || return 0
  failed_profiles="$(jq -er '.profiles | join(",")' <<<"$failed_workspace")" || return 0
  failed_container="$(docker container inspect --format '{{.Id}}' "$failed_container_name" 2>/dev/null)" || return 0
  [[ "$failed_container" =~ ^[0-9a-f]{64}$ ]] || return 0
  failed_project_path=/run/dim/project-root
  failed_compose=(--file .dim/docker-compose.yml)
  docker start "$failed_container" >/dev/null 2>&1 || true
  failed_ids="$(docker exec --user dim "$failed_container" \
    stat -c '%u:%g' "$failed_workspace_data/project" 2>/dev/null)" || return 0
  [[ "$failed_ids" =~ ^([0-9]+):([0-9]+)$ ]] || return 0
  failed_uid="${BASH_REMATCH[1]}"
  failed_gid="${BASH_REMATCH[2]}"
  if docker exec --user dim --workdir "$failed_project_path" "$failed_container" \
    test -f .dim/ci-registry-mirror.override.yml; then
    failed_compose+=(--file .dim/ci-registry-mirror.override.yml)
  fi
  docker exec --user dim "$failed_container" \
    sh -c 'cat /tmp/dim-agent-controller/agent.log 2>/dev/null || true' >&2 || true
  docker exec --user dim "$failed_container" \
    sh -c 'cat /tmp/dim-stateful-setup.log 2>/dev/null || true' >&2 || true
  for failed_action in ps logs; do
    docker exec --user dim --workdir "$failed_project_path" \
      --env "DIM_WORKSPACE_UID=$failed_uid" --env "DIM_WORKSPACE_GID=$failed_gid" \
      --env "DIM_WORKSPACE_DATA=$failed_workspace_data" --env "DIM_PROJECT_ROOT=$failed_project_path" \
      --env "DIM_PROJECT_MANIFEST=$failed_project_manifest" --env "COMPOSE_PROFILES=$failed_profiles" \
      "$failed_container" sh -eu -c '
        export GIT_AUTHOR_NAME="$DIM_GIT_USER_NAME" GIT_AUTHOR_EMAIL="$DIM_GIT_USER_EMAIL"
        export GIT_COMMITTER_NAME="$DIM_GIT_USER_NAME" GIT_COMMITTER_EMAIL="$DIM_GIT_USER_EMAIL"
        DIM_DEVELOPMENT_GATEWAY_PORT="$(dim-development-service gateway-port)"
        export DIM_DEVELOPMENT_GATEWAY_PORT
        exec docker compose --project-name dim-project "$@"
      ' sh "${failed_compose[@]}" "$failed_action" >&2 || true
  done
  return 0
}

cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    dim workspace discard "$workspace_name" --yes >/dev/null 2>&1 || cleanup_status=1
  fi
  if [[ -f "$state_root/projects/$project_name.json" ]]; then
    dim project purge "$project_name" --yes >/dev/null 2>&1 || cleanup_status=1
  fi
  stop_controller || cleanup_status=1
  if [[ -d "$controller_runtime_dir" ]]; then
    find "$controller_runtime_dir" -depth -delete 2>/dev/null || cleanup_status=1
  fi
  if [[ -d "$state_root/assets/project-roots" ]]; then
    find "$state_root/assets/project-roots" -type d -exec chmod u+w -- {} + 2>/dev/null || cleanup_status=1
  fi
  if [[ -d "$work_dir" ]]; then
    find "$work_dir" -depth -delete 2>/dev/null || cleanup_status=1
  fi
  if ((cleanup_status != 0)); then
    printf 'stateful development cleanup uncertain after body status %d\n' "$status" >&2
    exit 125
  fi
  exit "$status"
}
