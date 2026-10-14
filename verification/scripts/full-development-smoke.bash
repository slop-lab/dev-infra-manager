#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
source "$script_dir/lib/verification-stage-runner.bash"
DIM_VERIFICATION_STAGE_ENTRYPOINT="$script_dir/full-development-smoke.bash"
export DIM_VERIFICATION_STAGE_ENTRYPOINT

DIM_VERIFICATION_LOG_ROOT="${DIM_FULL_DEVELOPMENT_LOG_ROOT:-/tmp/dim-full-development-logs/$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export DIM_VERIFICATION_LOG_ROOT

source_tools_ready() {
  command -v node >/dev/null
  command -v pnpm >/dev/null
  command -v just >/dev/null
  test -f "$repo_root/pnpm-lock.yaml"
}

docker_ready() {
  docker info >/dev/null
  docker compose version >/dev/null
}

backend_ready() {
  systemctl is-active sysbox >/dev/null
  docker info 2>/dev/null | grep -Eq '^ Runtimes:.*sysbox-runc'
}

native_idle_images() {
  cd "$repo_root"
  just verify native-idle-service-images
}

control_plane_live() {
  cd "$repo_root"
  just verify control-plane-install-live
}

workspace_tool_setup() {
  cd "$repo_root"
  just verify workspace-user-setup
}

stateful_development() {
  cd "$repo_root"
  DIM_EXAMPLE_WORKSPACE_BACKEND=sysbox JUST_UNSTABLE=1 \
    bash verification/scripts/stateful-development-flow-smoke.bash
}

self_development() {
  cd "$repo_root"
  DIM_SELF_WORKSPACE_BACKEND=sysbox DIM_SELF_EXPECT_AGENT_UID=1001 \
    DIM_SELF_VERIFY_AGENT=1 JUST_UNSTABLE=1 just verify self-development
}

verification_stage_register source-tools source_tools_ready ""
verification_stage_register docker-ready docker_ready ""
verification_stage_register backend-ready backend_ready "docker-ready"
verification_stage_register native-idle-service-images native_idle_images \
  "source-tools docker-ready"
verification_stage_register control-plane-install-live control_plane_live \
  "source-tools docker-ready"
verification_stage_register workspace-user-setup workspace_tool_setup \
  "source-tools docker-ready"
verification_stage_register stateful-development stateful_development \
  "source-tools docker-ready backend-ready"
verification_stage_register self-development self_development \
  "source-tools docker-ready backend-ready"
if [[ -n "${DIM_VERIFICATION_INTERNAL_STAGE:-}" ]]; then
  verification_stage_run_internal "$DIM_VERIFICATION_INTERNAL_STAGE"
  exit
fi
verification_stage_run
