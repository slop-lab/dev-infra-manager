#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

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
    bash "$script_dir/verification-stage-runner-smoke.bash" >"$output" 2>&1 || status=$?
  printf '%s' "$status" >"$work_dir/$name.status"
}

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

cancel_output="$work_dir/cancel.out"
cancel_execution="$work_dir/cancel.execution"
cancel_processes="$work_dir/cancel.processes"
cancel_logs="$work_dir/cancel.logs"
: >"$cancel_execution"
DIM_VERIFICATION_BLOCKING_STAGE=backend \
  DIM_VERIFICATION_EXECUTION_LOG="$cancel_execution" \
  DIM_VERIFICATION_PROCESS_LOG="$cancel_processes" \
  DIM_VERIFICATION_LOG_ROOT="$cancel_logs" \
  bash "$script_dir/verification-stage-runner-smoke.bash" >"$cancel_output" 2>&1 &
cancel_runner=$!
for _ in $(seq 1 100); do
  [[ ! -s "$cancel_processes" ]] || break
  kill -0 "$cancel_runner" 2>/dev/null || break
  sleep 0.05
done
test -s "$cancel_processes"
read -r cancel_child cancel_descendant <"$cancel_processes"
kill -TERM "$cancel_runner"
cancel_status=0
wait "$cancel_runner" || cancel_status=$?
test "$cancel_status" -eq 143
for _ in $(seq 1 100); do
  [[ ! -e "/proc/$cancel_child" && ! -e "/proc/$cancel_descendant" ]] && break
  sleep 0.05
done
test ! -e "/proc/$cancel_child"
test ! -e "/proc/$cancel_descendant"
test "$(tr '\n' ' ' <"$cancel_execution")" = "source backend "
grep -Fqx 'BLOCKED native reason=cancelled stage=backend' "$cancel_output"
grep -Fqx 'BLOCKED ci reason=cancelled stage=backend' "$cancel_output"
grep -Fq 'verification-stage-summary passed=1 failed=1 blocked=5' "$cancel_output"

launch_bin="$work_dir/launch-bin"
launch_pid_file="$work_dir/launch.pid"
launch_output="$work_dir/launch.out"
launch_execution="$work_dir/launch.execution"
launch_logs="$work_dir/launch.logs"
mkdir "$launch_bin"
cat >"$launch_bin/setsid" <<'EOF'
#!/usr/bin/env bash
read -r -a process_stat <"/proc/$BASHPID/stat"
printf '%s %s\n' "$BASHPID" "${process_stat[21]}" >"${DIM_VERIFICATION_LAUNCH_PID_FILE:?}"
kill -TERM "$PPID"
kill -STOP "$BASHPID"
exec /usr/bin/setsid "$@"
EOF
chmod 0700 "$launch_bin/setsid"
: >"$launch_execution"
launch_status=0
DIM_VERIFICATION_EXECUTION_LOG="$launch_execution" \
  DIM_VERIFICATION_LAUNCH_PID_FILE="$launch_pid_file" \
  DIM_VERIFICATION_LOG_ROOT="$launch_logs" \
  PATH="$launch_bin:$PATH" \
  timeout --signal=KILL 2 bash "$script_dir/verification-stage-runner-smoke.bash" \
  >"$launch_output" 2>&1 || launch_status=$?
test -s "$launch_pid_file"
read -r launch_pid launch_start_time <"$launch_pid_file"
if [[ -r "/proc/$launch_pid/stat" ]]; then
  read -r -a launch_process_stat <"/proc/$launch_pid/stat"
  if [[ "${launch_process_stat[21]}" == "$launch_start_time" ]]; then
    kill -KILL "$launch_pid" 2>/dev/null || true
    wait "$launch_pid" 2>/dev/null || true
  fi
fi
for _ in $(seq 1 100); do
  [[ ! -e "/proc/$launch_pid" ]] && break
  sleep 0.05
done
test "$launch_status" -eq 143
test ! -e "/proc/$launch_pid"
test ! -s "$launch_execution"
grep -Fqx 'BLOCKED backend reason=cancelled stage=source' "$launch_output"
grep -Fq 'verification-stage-summary passed=0 failed=1 blocked=6' "$launch_output"

fake_bin="$work_dir/fake-bin"
mkdir "$fake_bin"
cat >"$fake_bin/just" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DIM_VERIFICATION_REAL_WIRING_LOG:?}"
exit "${DIM_VERIFICATION_REAL_WIRING_STATUS:-0}"
EOF
chmod 0700 "$fake_bin/just"
real_wiring_log="$work_dir/real-wiring.log"
DIM_VERIFICATION_REAL_WIRING_LOG="$real_wiring_log" \
  DIM_VERIFICATION_INTERNAL_STAGE=native-idle-service-images \
  PATH="$fake_bin:$PATH" \
  bash "$script_dir/full-development-smoke.bash"
real_wiring_status=0
DIM_VERIFICATION_REAL_WIRING_LOG="$real_wiring_log" \
  DIM_VERIFICATION_REAL_WIRING_STATUS=125 \
  DIM_VERIFICATION_INTERNAL_STAGE=common-full \
  PATH="$fake_bin:$PATH" \
  bash "$script_dir/kvm-guest-verification-smoke.bash" || real_wiring_status=$?
test "$real_wiring_status" -eq 125
test "$(tr '\n' ' ' <"$real_wiring_log")" = \
  "verify native-idle-service-images verify full-development "
invalid_internal_status=0
DIM_VERIFICATION_INTERNAL_STAGE=missing \
  bash "$script_dir/full-development-smoke.bash" >/dev/null 2>&1 || invalid_internal_status=$?
test "$invalid_internal_status" -eq 2

qemu_launcher="$script_dir/../../.dim/qemu-verify.bash"
qemu_status=0
bash "$qemu_launcher" --probe --verbose >"$work_dir/probe.out" 2>&1 || qemu_status=$?
test "$qemu_status" -eq 2
grep -Fqx -- '--probe does not accept --verbose' "$work_dir/probe.out"
qemu_status=0
bash "$qemu_launcher" --agent-control --cache-routing >"$work_dir/modes.out" 2>&1 || qemu_status=$?
test "$qemu_status" -eq 2
grep -Fqx -- '--probe, --agent-control, and --cache-routing are mutually exclusive' \
  "$work_dir/modes.out"
qemu_status=0
bash "$qemu_launcher" --cache-routing >"$work_dir/cache.out" 2>&1 || qemu_status=$?
test "$qemu_status" -eq 2
grep -Fqx 'DIM_KVM_REGISTRY_MIRROR is required for --cache-routing' \
  "$work_dir/cache.out"

printf 'fault-injection case=independent exit=%s commands=%s\n' \
  "$(<"$work_dir/independent.status")" "$(tr '\n' ',' <"$work_dir/independent.execution")"
grep -E '^(FAIL native|verification-stage-summary)' "$work_dir/independent.out"
printf 'fault-injection case=prerequisite exit=%s commands=%s\n' \
  "$(<"$work_dir/prerequisite.status")" "$(tr '\n' ',' <"$work_dir/prerequisite.execution")"
grep -E '^(FAIL backend|BLOCKED|verification-stage-summary)' "$work_dir/prerequisite.out"
printf 'fault-injection case=success exit=%s commands=%s\n' \
  "$(<"$work_dir/success.status")" "$(tr '\n' ',' <"$work_dir/success.execution")"
grep -E '^verification-stage-summary' "$work_dir/success.out"
printf 'fault-injection case=cleanup exit=%s commands=%s\n' \
  "$(<"$work_dir/cleanup.status")" "$(tr '\n' ',' <"$work_dir/cleanup.execution")"
grep -E '^(FAIL backend|BLOCKED|verification-stage-summary)' "$work_dir/cleanup.out"
printf 'fault-injection case=cleanup-prior-failure exit=%s commands=%s\n' \
  "$(<"$work_dir/cleanup-prior-failure.status")" "$(tr '\n' ',' <"$work_dir/cleanup-prior-failure.execution")"
grep -E '^(fixture-body-status|FAIL backend|BLOCKED|verification-stage-summary)' \
  "$work_dir/cleanup-prior-failure.out"
printf 'fault-injection case=evidence exit=%s commands=%s\n' \
  "$(<"$work_dir/evidence.status")" "$(tr '\n' ',' <"$work_dir/evidence.execution")"
grep -E '^(FAIL native|verification-stage-summary)' "$work_dir/evidence.out"
printf 'fault-injection case=cancel exit=%s child=%s descendant=%s commands=%s\n' \
  "$cancel_status" "$cancel_child" "$cancel_descendant" "$(tr '\n' ',' <"$cancel_execution")"
grep -E '^(FAIL backend|BLOCKED|verification-stage-summary)' "$cancel_output"
printf 'launch-window-cancel exit=%s leader=%s commands=%s\n' \
  "$launch_status" "$launch_pid" "$(tr '\n' ',' <"$launch_execution")"
grep -E '^(FAIL source|BLOCKED|verification-stage-summary)' "$launch_output"
printf 'real-phase-wiring outer-status=%s commands=%s\n' \
  "$real_wiring_status" "$(tr '\n' ',' <"$real_wiring_log")"
printf 'qemu-mode-validation probe=%d mutual-exclusion=%d cache-prerequisite=%d\n' 2 2 2
printf 'verification-stage-runner-test-ok\n'
