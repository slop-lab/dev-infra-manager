#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/verification-stage-runner.bash"
DIM_VERIFICATION_STAGE_ENTRYPOINT="$script_dir/verification-stage-runner-smoke.bash"
export DIM_VERIFICATION_STAGE_ENTRYPOINT

DIM_VERIFICATION_LOG_ROOT="${DIM_VERIFICATION_LOG_ROOT:-$(mktemp -d)}"
export DIM_VERIFICATION_LOG_ROOT

run_fixture_stage() {
  local stage="$1"
  if [[ -n "${DIM_VERIFICATION_INTERNAL_STAGE+x}" ]]; then
    printf 'leaked internal verification stage: %s\n' "$DIM_VERIFICATION_INTERNAL_STAGE" >&2
    return 97
  fi
  printf '%s\n' "$stage" >>"${DIM_VERIFICATION_EXECUTION_LOG:?}"
  case ",${DIM_VERIFICATION_CLEANUP_FAILURES:-}," in
    *,"$stage",*)
      fixture_cleanup_uncertain() {
        local body_status=$?
        trap - EXIT
        printf 'fixture-body-status=%d cleanup-status=125\n' "$body_status"
        exit 125
      }
      trap fixture_cleanup_uncertain EXIT
      trap 'exit 143' TERM
      ;;
  esac
  case ",${DIM_VERIFICATION_FAILURES:-}," in
    *,"$stage",*) false; printf 'errexit-broken=%s\n' "$stage" ;;
  esac
  case ",${DIM_VERIFICATION_EVIDENCE_FAILURES:-}," in
    *,"$stage",*) rm -f "$DIM_VERIFICATION_LOG_ROOT/$stage.log"; mkdir "$DIM_VERIFICATION_LOG_ROOT/$stage.log" ;;
  esac
  if [[ "${DIM_VERIFICATION_SIGNAL_EXIT_STAGE:-}" == "$stage" ]]; then
    kill -TERM "$BASHPID"
    wait
  fi
  if [[ "${DIM_VERIFICATION_CLEANUP_BLOCKING_STAGE:-}" == "$stage" ]]; then
    /usr/bin/sleep 300 &
    printf '%s\n' "$BASHPID" >"${DIM_VERIFICATION_PROCESS_LOG:?}"
    wait
  fi
  if [[ "${DIM_VERIFICATION_BLOCKING_STAGE:-}" == "$stage" ]]; then
    /usr/bin/bash -c '
      trap "" INT TERM HUP
      /usr/bin/sleep 300 &
      printf "%s %s\n" "$BASHPID" "$!" >"$1"
      wait
    ' bash "${DIM_VERIFICATION_PROCESS_LOG:?}" &
    wait
  fi
}

stage_foundation() { run_fixture_stage foundation; }
stage_capability() { run_fixture_stage capability; }
stage_independent() { run_fixture_stage independent; }
stage_dependent_a() { run_fixture_stage dependent-a; }
stage_dependent_b() { run_fixture_stage dependent-b; }
stage_dependent_c() { run_fixture_stage dependent-c; }
stage_dependent_d() { run_fixture_stage dependent-d; }

verification_stage_register foundation stage_foundation ""
verification_stage_register capability stage_capability "foundation"
verification_stage_register independent stage_independent "foundation"
verification_stage_register dependent-a stage_dependent_a "foundation capability"
verification_stage_register dependent-b stage_dependent_b "foundation capability"
verification_stage_register dependent-c stage_dependent_c "foundation capability"
verification_stage_register dependent-d stage_dependent_d "foundation capability"
if [[ -n "${DIM_VERIFICATION_INTERNAL_STAGE:-}" ]]; then
  verification_stage_run_internal "$DIM_VERIFICATION_INTERNAL_STAGE"
  exit
fi
verification_stage_run
