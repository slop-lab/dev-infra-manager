#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/git-clone-source.bash
source "$script_dir/lib/git-clone-source.bash"
# shellcheck source=lib/test-registry-mirror.bash
source "$script_dir/lib/test-registry-mirror.bash"

project_name="dim-self-smoke"
workspace_name="dim-self-smoke"
container_name=""
workspace_volume_name=""
state_root="/tmp/dim-self-smoke-state"
source_root="/tmp/dim-self-smoke-source"
agent_verification_log="$state_root/agent-verification.log"
workspace_creation_log="$state_root/workspace-creation.log"
verification_stage="initialization"
dim_bin="${DIM_BIN:-$PWD/core/packages/cli/dist/cli.js}"
project_source="$(cd -- "$script_dir/../.." && pwd)"
integrated_source="$project_source"
# shellcheck source=lib/container-self-project-ssh-fixture.bash
source "$script_dir/lib/container-self-project-ssh-fixture.bash"
# shellcheck source=lib/self-project-phase-runner.bash
source "$script_dir/lib/self-project-phase-runner.bash"
# shellcheck source=lib/container-self-project-workspace-checks.bash
source "$script_dir/lib/container-self-project-workspace-checks.bash"
# shellcheck source=lib/container-self-project-ssh-checks.bash
source "$script_dir/lib/container-self-project-ssh-checks.bash"
# shellcheck source=lib/container-self-project-agent-checks.bash
source "$script_dir/lib/container-self-project-agent-checks.bash"
# shellcheck source=lib/container-self-project-setup.bash
source "$script_dir/lib/container-self-project-setup.bash"
# shellcheck source=lib/container-self-project-final-phases.bash
source "$script_dir/lib/container-self-project-final-phases.bash"

self_phase_register workspace self_project_workspace_phase "" "workspace runtime and lifecycle contracts"
self_phase_register ssh self_project_ssh_checks "" "SSH authority and isolation contracts"
self_phase_register agent self_project_agent_checks "" "agent, repository, and nested-runtime contracts"
self_phase_register publication self_project_publication_checks "" "managed repository publication"
self_phase_register retained-volume self_project_retained_volume_checks \
  "workspace ssh agent publication" "destructive retained-volume lifecycle"
if [[ "${DIM_SELF_STOP_AFTER_QEMU_PROBE:-0}" == 1 && -z "${DIM_SELF_PHASES:-}" && $# == 0 ]]; then
  DIM_SELF_PHASES=workspace
fi
self_phase_parse "$@"
DIM_PHASE_LOG_ROOT="${DIM_SELF_PHASE_LOG_ROOT:-/tmp/dim-self-project-smoke-logs/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export DIM_PHASE_LOG_ROOT

for required_command in ssh ssh-keygen sha256sum; do
  command -v "$required_command" >/dev/null || {
    printf 'unavailable: container self-project smoke requires %s\n' "$required_command" >&2
    exit 2
  }
done

exec 9> /tmp/dim-self-smoke.lock
if ! flock --nonblock 9; then
  echo "another container self-project smoke is already running" >&2
  exit 1
fi

dim() {
  if [[ -n "${DIM_BIN:-}" ]]; then
    command "$dim_bin" "$@"
  else
    node "$dim_bin" "$@"
  fi
}

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$state_root/dim.json"
export DIM_PLUGIN_HOME="$state_root/plugins"
export GIT_CONFIG_GLOBAL="$state_root/host.gitconfig"

cleanup_managed_resources() {
  local failed=0
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    workspace_json="$(dim workspace show "$workspace_name" --json)" || return 1
    container_name="$(jq -er .containerName <<<"$workspace_json")" || return 1
    workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")" || return 1
    if ! dim workspace discard "$workspace_name" --yes; then
      echo "failed to discard self-project smoke workspace '$workspace_name'" >&2
      failed=1
    fi
  fi
  if [[ -n "$workspace_volume_name" ]] && \
    docker volume inspect "$workspace_volume_name" >/dev/null 2>&1; then
    if ! docker volume rm "$workspace_volume_name" >/dev/null; then
      echo "failed to remove self-project smoke volume '$workspace_volume_name'" >&2
      failed=1
    fi
  fi
  if [[ -f "$state_root/projects/$project_name.json" ]]; then
    if ! dim project purge "$project_name" --yes; then
      echo "failed to purge self-project smoke Project '$project_name'" >&2
      failed=1
    fi
  fi
  return "$failed"
}

if [[ -d "$state_root" ]]; then
  echo "recover previous container self-project smoke state"
  if ! cleanup_managed_resources; then
    echo "retained DIM_STATE_ROOT=$state_root for manual recovery" >&2
    exit 1
  fi
  find "$state_root" -depth -delete
  find "$source_root" -depth -delete 2>/dev/null || true
fi

mkdir -p "$state_root" "$source_root"
git config --file "$GIT_CONFIG_GLOBAL" user.name "DIM Self Host"
git config --file "$GIT_CONFIG_GLOBAL" user.email "dim-self-host@dim.invalid"
prepare_self_ssh_fixture
mkdir -p "$DIM_PLUGIN_HOME"
printf '%s\n' '{"schemaVersion":1,"plugins":[]}' >"$DIM_PLUGIN_HOME/plugins.json"
bash "$script_dir/configure-user-backend.bash" "${DIM_SELF_WORKSPACE_BACKEND:-sysbox}"

cleanup() {
  local status=$?
  trap - EXIT
  if cleanup_managed_resources; then
    if [[ "$status" -ne 0 ]]; then
      echo "self-Project verification failed during: $verification_stage" >&2
    fi
    if [[ "$status" -ne 0 && "$verification_stage" == "workspace creation" && -s "$workspace_creation_log" ]]; then
      echo "workspace creation failed; last 120 log lines:" >&2
      tail -n 120 "$workspace_creation_log" >&2
    fi
    if [[ "$status" -ne 0 && -s "$agent_verification_log" ]]; then
      echo "agent verification failed; last 120 log lines:" >&2
      tail -n 120 "$agent_verification_log" >&2
    fi
    find "$state_root" -depth -delete 2>/dev/null || true
    find "$source_root" -depth -delete 2>/dev/null || true
  else
    echo "retained DIM_STATE_ROOT=$state_root for manual recovery" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
prepare_self_project_workspace
verification_stage="selected phase execution"
self_phase_run
echo "container-self-project-smoke-ok"
