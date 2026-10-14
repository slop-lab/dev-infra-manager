cancel_output="$work_dir/cancel.out"
cancel_execution="$work_dir/cancel.execution"
cancel_processes="$work_dir/cancel.processes"
cancel_logs="$work_dir/cancel.logs"
: >"$cancel_execution"
DIM_VERIFICATION_BLOCKING_STAGE=capability \
  DIM_VERIFICATION_EXECUTION_LOG="$cancel_execution" \
  DIM_VERIFICATION_PROCESS_LOG="$cancel_processes" \
  DIM_VERIFICATION_LOG_ROOT="$cancel_logs" \
  bash "$runner_fixture" >"$cancel_output" 2>&1 &
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
test "$cancel_status" -eq 125
for _ in $(seq 1 100); do
  [[ ! -e "/proc/$cancel_child" && ! -e "/proc/$cancel_descendant" ]] && break
  sleep 0.05
done
test ! -e "/proc/$cancel_child"
test ! -e "/proc/$cancel_descendant"
test "$(tr '\n' ' ' <"$cancel_execution")" = "foundation capability "
grep -Fqx 'BLOCKED independent reason=unsafe-cleanup stage=capability' "$cancel_output"
grep -Fqx 'BLOCKED dependent-d reason=unsafe-cleanup stage=capability' "$cancel_output"
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
  timeout --signal=KILL 5 bash "$runner_fixture" \
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
if ((launch_status != 125)); then cat "$launch_output" >&2; fi
test "$launch_status" -eq 125
test ! -e "/proc/$launch_pid"
test ! -s "$launch_execution"
grep -Fqx 'BLOCKED capability reason=unsafe-cleanup stage=foundation' "$launch_output"
grep -Fq 'verification-stage-summary passed=0 failed=1 blocked=6' "$launch_output"
