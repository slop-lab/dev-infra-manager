run_case independent native
test "$(<"$work_dir/independent.status")" -ne 0
test "$(tr '\n' ' ' <"$work_dir/independent.execution")" = \
  "source backend native stateful self trusted ci "
grep -Fqx 'FAIL native status=1 log='"$work_dir/independent.logs/native.log" \
  "$work_dir/independent.out"
grep -Fq 'verification-stage-summary passed=6 failed=1 blocked=0' \
  "$work_dir/independent.out"
! grep -Fq 'errexit-broken=native' "$work_dir/independent.out"

run_case prerequisite backend
test "$(<"$work_dir/prerequisite.status")" -ne 0
test "$(tr '\n' ' ' <"$work_dir/prerequisite.execution")" = \
  "source backend native "
grep -Fqx 'FAIL backend status=1 log='"$work_dir/prerequisite.logs/backend.log" \
  "$work_dir/prerequisite.out"
grep -Fqx 'BLOCKED stateful dependency=backend dependency_status=FAIL' \
  "$work_dir/prerequisite.out"
grep -Fqx 'BLOCKED ci dependency=backend dependency_status=FAIL' \
  "$work_dir/prerequisite.out"
grep -Fq 'verification-stage-summary passed=2 failed=1 blocked=4' \
  "$work_dir/prerequisite.out"

run_case success ""
test "$(<"$work_dir/success.status")" -eq 0
grep -Fq 'verification-stage-summary passed=7 failed=0 blocked=0' \
  "$work_dir/success.out"

run_case cleanup "" backend
test "$(<"$work_dir/cleanup.status")" -eq 125
test "$(tr '\n' ' ' <"$work_dir/cleanup.execution")" = \
  "source backend "
grep -Fqx 'FAIL backend status=125 log='"$work_dir/cleanup.logs/backend.log" \
  "$work_dir/cleanup.out"
grep -Fqx 'BLOCKED native reason=unsafe-cleanup stage=backend' \
  "$work_dir/cleanup.out"
grep -Fqx 'BLOCKED ci reason=unsafe-cleanup stage=backend' \
  "$work_dir/cleanup.out"
grep -Fq 'verification-stage-summary passed=1 failed=1 blocked=5' \
  "$work_dir/cleanup.out"

run_case cleanup-prior-failure backend backend
test "$(<"$work_dir/cleanup-prior-failure.status")" -eq 125
grep -Fqx 'fixture-body-status=1 cleanup-status=125' \
  "$work_dir/cleanup-prior-failure.out"
grep -Fqx 'FAIL backend status=125 log='"$work_dir/cleanup-prior-failure.logs/backend.log" \
  "$work_dir/cleanup-prior-failure.out"

run_case evidence "" "" native
test "$(<"$work_dir/evidence.status")" -ne 0
test "$(tr '\n' ' ' <"$work_dir/evidence.execution")" = \
  "source backend native stateful self trusted ci "
grep -Fqx 'FAIL native status=1 log='"$work_dir/evidence.logs/native.log" \
  "$work_dir/evidence.out"
grep -Fq 'verification-stage-summary passed=6 failed=1 blocked=0' \
  "$work_dir/evidence.out"

invalid_group_status=0
DIM_VERIFICATION_EXECUTION_LOG="$work_dir/invalid-group.execution" \
  DIM_VERIFICATION_LOG_ROOT="$work_dir/invalid-group.logs" \
  DIM_VERIFICATION_MANAGED_PGID=2 \
  bash "$runner_fixture" >"$work_dir/invalid-group.out" 2>&1 || invalid_group_status=$?
test "$invalid_group_status" -eq 2
grep -Fqx 'managed verification stage process group is invalid' \
  "$work_dir/invalid-group.out"

signal_output="$work_dir/signal.out"
signal_execution="$work_dir/signal.execution"
signal_logs="$work_dir/signal.logs"
signal_status=0
: >"$signal_execution"
DIM_VERIFICATION_EXECUTION_LOG="$signal_execution" \
  DIM_VERIFICATION_LOG_ROOT="$signal_logs" \
  DIM_VERIFICATION_SIGNAL_EXIT_STAGE=backend \
  bash "$runner_fixture" >"$signal_output" 2>&1 || signal_status=$?
test "$signal_status" -eq 143
test "$(tr '\n' ' ' <"$signal_execution")" = "source backend "
grep -Fqx 'BLOCKED native reason=cancelled stage=backend' "$signal_output"
grep -Fqx 'BLOCKED ci reason=cancelled stage=backend' "$signal_output"
grep -Fq 'verification-stage-summary passed=1 failed=1 blocked=5' "$signal_output"

cleanup_cancel_output="$work_dir/cleanup-cancel.out"
cleanup_cancel_execution="$work_dir/cleanup-cancel.execution"
cleanup_cancel_process="$work_dir/cleanup-cancel.process"
cleanup_cancel_logs="$work_dir/cleanup-cancel.logs"
cleanup_cancel_status=0
: >"$cleanup_cancel_execution"
DIM_VERIFICATION_CLEANUP_BLOCKING_STAGE=backend \
  DIM_VERIFICATION_CLEANUP_FAILURES=backend \
  DIM_VERIFICATION_EXECUTION_LOG="$cleanup_cancel_execution" \
  DIM_VERIFICATION_LOG_ROOT="$cleanup_cancel_logs" \
  DIM_VERIFICATION_PROCESS_LOG="$cleanup_cancel_process" \
  bash "$runner_fixture" >"$cleanup_cancel_output" 2>&1 &
cleanup_cancel_runner=$!
for _ in $(seq 1 100); do
  [[ ! -s "$cleanup_cancel_process" ]] || break
  kill -0 "$cleanup_cancel_runner" 2>/dev/null || break
  sleep 0.05
done
test -s "$cleanup_cancel_process"
cleanup_cancel_child="$(<"$cleanup_cancel_process")"
kill -TERM "$cleanup_cancel_runner"
wait "$cleanup_cancel_runner" || cleanup_cancel_status=$?
if ((cleanup_cancel_status != 125)); then cat "$cleanup_cancel_output" >&2; fi
test "$cleanup_cancel_status" -eq 125
test ! -e "/proc/$cleanup_cancel_child"
grep -Fqx 'fixture-body-status=143 cleanup-status=125' "$cleanup_cancel_output"
grep -Fqx 'FAIL backend status=125 log='"$cleanup_cancel_logs/backend.log" \
  "$cleanup_cancel_output"
grep -Fqx 'BLOCKED native reason=unsafe-cleanup stage=backend' "$cleanup_cancel_output"
grep -Fqx 'BLOCKED ci reason=unsafe-cleanup stage=backend' "$cleanup_cancel_output"
