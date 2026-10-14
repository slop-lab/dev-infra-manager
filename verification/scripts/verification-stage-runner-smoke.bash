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
      ;;
  esac
  case ",${DIM_VERIFICATION_FAILURES:-}," in
    *,"$stage",*) false; printf 'errexit-broken=%s\n' "$stage" ;;
  esac
  case ",${DIM_VERIFICATION_EVIDENCE_FAILURES:-}," in
    *,"$stage",*) rm -f "$DIM_VERIFICATION_LOG_ROOT/$stage.log"; mkdir "$DIM_VERIFICATION_LOG_ROOT/$stage.log" ;;
  esac
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

stage_source() { run_fixture_stage source; }
stage_backend() { run_fixture_stage backend; }
stage_native() { run_fixture_stage native; }
stage_stateful() { run_fixture_stage stateful; }
stage_self() { run_fixture_stage self; }
stage_trusted() { run_fixture_stage trusted; }
stage_ci() { run_fixture_stage ci; }

verification_stage_register source stage_source ""
verification_stage_register backend stage_backend "source"
verification_stage_register native stage_native "source"
verification_stage_register stateful stage_stateful "source backend"
verification_stage_register self stage_self "source backend"
verification_stage_register trusted stage_trusted "source backend"
verification_stage_register ci stage_ci "source backend"
if [[ -n "${DIM_VERIFICATION_INTERNAL_STAGE:-}" ]]; then
  verification_stage_run_internal "$DIM_VERIFICATION_INTERNAL_STAGE"
  exit
fi
verification_stage_run
