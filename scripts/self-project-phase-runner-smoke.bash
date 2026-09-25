#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/self-project-phase-runner.bash
source "$script_dir/lib/self-project-phase-runner.bash"

DIM_PHASE_LOG_ROOT="${DIM_PHASE_LOG_ROOT:-$(mktemp -d)}"
export DIM_PHASE_LOG_ROOT

run_driver_phase() {
  local phase="$1"
  printf 'phase-driver-executed=%s\n' "$phase"
  if [[ -n "${DIM_PHASE_DRIVER_EXECUTION_LOG:-}" ]]; then
    printf '%s\n' "$phase" >>"$DIM_PHASE_DRIVER_EXECUTION_LOG"
  fi
  case ",${DIM_PHASE_DRIVER_FAILURES:-}," in
    *,"$phase",*) false; printf 'phase-driver-errexit-broken=%s\n' "$phase" ;;
  esac
}

phase_workspace() { run_driver_phase workspace; }
phase_ssh() { run_driver_phase ssh; }
phase_agent() { run_driver_phase agent; }
phase_publication() { run_driver_phase publication; }
phase_retained_volume() { run_driver_phase retained-volume; }

self_phase_register workspace phase_workspace "" "workspace"
self_phase_register ssh phase_ssh "" "SSH"
self_phase_register agent phase_agent "" "agent"
self_phase_register publication phase_publication "" "publication"
self_phase_register retained-volume phase_retained_volume \
  "workspace ssh agent publication" "retained volume"
self_phase_parse "$@"
self_phase_run
