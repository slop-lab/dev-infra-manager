#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
runner_fixture_dir="$work_dir/runner-fixture"
mkdir -p "$runner_fixture_dir/lib"
cp "$script_dir/verification-stage-runner-smoke.bash" "$runner_fixture_dir/verification-stage-runner-smoke.bash"
sed 's/attempt < 1800/attempt < 20/' "$script_dir/lib/verification-stage-runner.bash" \
  >"$runner_fixture_dir/lib/verification-stage-runner.bash"
runner_fixture="$runner_fixture_dir/verification-stage-runner-smoke.bash"

run_case() {
  local name="$1" failures="$2" cleanup_failures="${3:-}" evidence_failures="${4:-}"
  local output="$work_dir/$name.out" execution="$work_dir/$name.execution"
  local logs="$work_dir/$name.logs" status=0
  : >"$execution"
  DIM_VERIFICATION_FAILURES="$failures" \
    DIM_VERIFICATION_CLEANUP_FAILURES="$cleanup_failures" \
    DIM_VERIFICATION_EVIDENCE_FAILURES="$evidence_failures" \
    DIM_VERIFICATION_EXECUTION_LOG="$execution" \
    DIM_VERIFICATION_LOG_ROOT="$logs" \
    DIM_CHECK_VERBOSE="${5:-0}" \
    bash "$runner_fixture" >"$output" 2>&1 || status=$?
  printf '%s' "$status" >"$work_dir/$name.status"
}

fixture_source_dir="$script_dir/../../tests/scenarios/harness/fixtures/stage-runner"
source "$fixture_source_dir/fault-cases.bash"
source "$fixture_source_dir/cancellation-cases.bash"
printf 'verification-stage-runner-test-ok\n'
