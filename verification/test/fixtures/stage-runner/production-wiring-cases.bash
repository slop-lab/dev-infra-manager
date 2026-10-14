fake_bin="$work_dir/fake-bin"
mkdir "$fake_bin"
cat >"$fake_bin/just" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DIM_VERIFICATION_REAL_WIRING_LOG:?}"
if [[ -n "${DIM_VERIFICATION_EXPECTED_LOG_ROOT:-}" ]]; then
  if [[ "${DIM_VERIFICATION_LOG_ROOT:-}" != "$DIM_VERIFICATION_EXPECTED_LOG_ROOT" \
    || ! -d "$DIM_VERIFICATION_LOG_ROOT" ]]; then
    printf 'verification log root mismatch: expected=%s actual=%s exists=%s\n' \
      "$DIM_VERIFICATION_EXPECTED_LOG_ROOT" "${DIM_VERIFICATION_LOG_ROOT:-}" \
      "$([[ -d "${DIM_VERIFICATION_LOG_ROOT:-}" ]] && printf true || printf false)" >&2
    exit 98
  fi
  printf '%s\t%s\n' "$DIM_VERIFICATION_LOG_ROOT" "$*" \
    >>"${DIM_VERIFICATION_LOG_ROOT_TRACE:?}"
fi
if [[ "$*" == "verify full-development" && "${DIM_VERIFICATION_NESTED_CHAIN:-0}" == 1 ]]; then
  if [[ -n "${DIM_VERIFICATION_NESTED_CANCEL_ROOT_PGID:-}" ]]; then
    read -r -a root_process_stat <"/proc/$BASHPID/stat"
    printf '%s\n' "${root_process_stat[4]}" >"$DIM_VERIFICATION_NESTED_CANCEL_ROOT_PGID"
  fi
  export DIM_VERIFICATION_EXPECTED_LOG_ROOT="${DIM_FULL_DEVELOPMENT_LOG_ROOT:?}"
  exec /usr/bin/bash "${DIM_VERIFICATION_FULL_DEVELOPMENT_ENTRYPOINT:?}"
fi
if [[ "${DIM_VERIFICATION_ASSERT_SELECTOR_ABSENT:-0}" == 1 && -n "${DIM_VERIFICATION_INTERNAL_STAGE+x}" ]]; then
  printf 'leaked internal verification stage: %s\n' "$DIM_VERIFICATION_INTERNAL_STAGE" >&2
  exit 97
fi
if [[ "$*" == "${DIM_VERIFICATION_REAL_WIRING_FAILURE:-}" ]]; then
  exit 7
fi
if [[ "$*" == "verify control-plane-install-live" && "${DIM_VERIFICATION_NESTED_CANCEL:-0}" == 1 ]]; then
  nested_cleanup() {
    local body_status=$?
    trap - EXIT
    trap '' TERM
    printf 'cleanup-start status=%s\n' "$body_status" >>"${DIM_VERIFICATION_NESTED_CANCEL_TRACE:?}"
    local cleanup_started=$SECONDS
    while ((SECONDS - cleanup_started < 3)); do :; done
    wait "$nested_child" 2>/dev/null || true
    printf 'cleanup-done status=%s\n' "$body_status" >>"$DIM_VERIFICATION_NESTED_CANCEL_TRACE"
    exit "$body_status"
  }
  trap nested_cleanup EXIT
  trap 'exit 143' TERM
  /usr/bin/bash -c '
    trap "sleep 0.4; exit 143" TERM
    /usr/bin/bash -c '\''trap "sleep 0.4; exit 143" TERM; while :; do sleep 10; done'\'' &
    printf "%s %s\n" "$BASHPID" "$!" >"$1"
    wait
  ' bash "${DIM_VERIFICATION_NESTED_CANCEL_DESCENDANTS:?}" &
  nested_child=$!
  while [[ ! -s "$DIM_VERIFICATION_NESTED_CANCEL_DESCENDANTS" ]]; do sleep 0.01; done
  read -r nested_child_pid nested_grandchild_pid <"$DIM_VERIFICATION_NESTED_CANCEL_DESCENDANTS"
  printf '%s %s %s\n' "$BASHPID" "$nested_child_pid" "$nested_grandchild_pid" \
    >"${DIM_VERIFICATION_NESTED_CANCEL_PIDS:?}"
  printf 'stage-ready\n' >>"$DIM_VERIFICATION_NESTED_CANCEL_TRACE"
  wait "$nested_child"
fi
exit "${DIM_VERIFICATION_REAL_WIRING_STATUS:-0}"
EOF
cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
[[ -z "${DIM_VERIFICATION_INTERNAL_STAGE+x}" ]] || exit 97
printf 'docker %s\n' "$*" >>"${DIM_VERIFICATION_REAL_WIRING_LOG:?}"
if [[ "${1:-}" == info ]]; then
  printf ' Runtimes: runc sysbox-runc\n'
fi
EOF
cat >"$fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ -z "${DIM_VERIFICATION_INTERNAL_STAGE+x}" ]] || exit 97
printf 'systemctl %s\n' "$*" >>"${DIM_VERIFICATION_REAL_WIRING_LOG:?}"
EOF
cat >"$fake_bin/bash" <<'EOF'
#!/usr/bin/bash
if [[ "$*" == "verification/scripts/stateful-development-flow-smoke.bash" ]]; then
  [[ -z "${DIM_VERIFICATION_INTERNAL_STAGE+x}" ]] || exit 97
  printf 'bash %s\n' "$*" >>"${DIM_VERIFICATION_REAL_WIRING_LOG:?}"
  exit 0
fi
if [[ "$*" == "verification/scripts/ci-runner-example-smoke.bash" \
  && "${DIM_VERIFICATION_NESTED_CANCEL:-0}" == 1 ]]; then
  printf 'follower-ran\n' >>"${DIM_VERIFICATION_NESTED_CANCEL_TRACE:?}"
  exit 0
fi
exec /usr/bin/bash "$@"
EOF
chmod 0700 "$fake_bin/just"
chmod 0700 "$fake_bin/docker" "$fake_bin/systemctl" "$fake_bin/bash"
real_wiring_log="$work_dir/real-wiring.log"
real_wiring_root_trace="$work_dir/real-wiring-roots.log"
full_internal_logs="$work_dir/full-internal.logs"
kvm_internal_logs="$work_dir/kvm-internal.logs"
mkdir "$full_internal_logs" "$kvm_internal_logs"
DIM_VERIFICATION_REAL_WIRING_LOG="$real_wiring_log" \
  DIM_VERIFICATION_LOG_ROOT_TRACE="$real_wiring_root_trace" \
  DIM_VERIFICATION_EXPECTED_LOG_ROOT="$full_internal_logs" \
  DIM_VERIFICATION_LOG_ROOT="$full_internal_logs" \
  DIM_FULL_DEVELOPMENT_LOG_ROOT="$work_dir/full-internal-decoy.logs" \
  DIM_VERIFICATION_INTERNAL_STAGE=native-idle-service-images \
  PATH="$fake_bin:$PATH" \
  bash "$script_dir/full-development-smoke.bash"
real_wiring_status=0
DIM_VERIFICATION_REAL_WIRING_LOG="$real_wiring_log" \
  DIM_VERIFICATION_LOG_ROOT_TRACE="$real_wiring_root_trace" \
  DIM_VERIFICATION_EXPECTED_LOG_ROOT="$kvm_internal_logs" \
  DIM_VERIFICATION_LOG_ROOT="$kvm_internal_logs" \
  DIM_KVM_GUEST_LOG_ROOT="$work_dir/kvm-internal-decoy.logs" \
  DIM_VERIFICATION_REAL_WIRING_STATUS=125 \
  DIM_VERIFICATION_INTERNAL_STAGE=common-full \
  PATH="$fake_bin:$PATH" \
  bash "$script_dir/kvm-guest-verification-smoke.bash" || real_wiring_status=$?
test "$real_wiring_status" -eq 125
test "$(tr '\n' ' ' <"$real_wiring_log")" = \
  "verify native-idle-service-images verify full-development "
grep -Fqx "$full_internal_logs"$'\t''verify native-idle-service-images' \
  "$real_wiring_root_trace"
grep -Fqx "$kvm_internal_logs"$'\t''verify full-development' \
  "$real_wiring_root_trace"
real_wiring_commands="$(tr '\n' ',' <"$real_wiring_log")"
nested_success_output="$work_dir/nested-success.out"
nested_success_logs="$work_dir/nested-success.logs"
nested_success_parent_logs="$work_dir/nested-success-parent.logs"
nested_success_status=0
mkdir "$nested_success_parent_logs"
: >"$real_wiring_log"
DIM_FULL_DEVELOPMENT_LOG_ROOT="$nested_success_logs" \
  DIM_VERIFICATION_ASSERT_SELECTOR_ABSENT=1 \
  DIM_VERIFICATION_EXPECTED_LOG_ROOT="$nested_success_parent_logs" \
  DIM_VERIFICATION_FULL_DEVELOPMENT_ENTRYPOINT="$script_dir/full-development-smoke.bash" \
  DIM_VERIFICATION_LOG_ROOT="$nested_success_parent_logs" \
  DIM_VERIFICATION_LOG_ROOT_TRACE="$real_wiring_root_trace" \
  DIM_VERIFICATION_NESTED_CHAIN=1 \
  DIM_VERIFICATION_REAL_WIRING_LOG="$real_wiring_log" \
  DIM_VERIFICATION_INTERNAL_STAGE=common-full \
  PATH="$fake_bin:$PATH" \
  bash "$script_dir/kvm-guest-verification-smoke.bash" >"$nested_success_output" 2>&1 || nested_success_status=$?
if ((nested_success_status != 0)); then
  cat "$nested_success_output" >&2
fi
test "$nested_success_status" -eq 0
grep -Fqx "verification-stage-summary passed=8 failed=0 blocked=0 logs=$nested_success_logs" \
  "$nested_success_output"
test -d "$nested_success_logs"
for nested_stage in source-tools docker-ready backend-ready native-idle-service-images \
  control-plane-install-live workspace-user-setup stateful-development self-development; do
  grep -Fq "PASS $nested_stage status=0" "$nested_success_output"
  test -f "$nested_success_logs/$nested_stage.log"
  test "$(stat -c '%a' "$nested_success_logs/$nested_stage.log")" = 600
done
! grep -R -Fq 'leaked internal verification stage:' \
  "$nested_success_output" "$nested_success_logs"
test "$(tr '\n' ' ' <"$real_wiring_log")" = \
  "verify full-development docker info docker compose version systemctl is-active sysbox docker info verify native-idle-service-images verify control-plane-install-live verify workspace-user-setup bash verification/scripts/stateful-development-flow-smoke.bash verify self-development "
nested_failure_output="$work_dir/nested-failure.out"
nested_failure_logs="$work_dir/nested-failure.logs"
nested_failure_parent_logs="$work_dir/nested-failure-parent.logs"
nested_failure_status=0
mkdir "$nested_failure_parent_logs"
: >"$real_wiring_log"
DIM_FULL_DEVELOPMENT_LOG_ROOT="$nested_failure_logs" \
  DIM_VERIFICATION_ASSERT_SELECTOR_ABSENT=1 \
  DIM_VERIFICATION_EXPECTED_LOG_ROOT="$nested_failure_parent_logs" \
  DIM_VERIFICATION_FULL_DEVELOPMENT_ENTRYPOINT="$script_dir/full-development-smoke.bash" \
  DIM_VERIFICATION_LOG_ROOT="$nested_failure_parent_logs" \
  DIM_VERIFICATION_LOG_ROOT_TRACE="$real_wiring_root_trace" \
  DIM_VERIFICATION_NESTED_CHAIN=1 \
  DIM_VERIFICATION_REAL_WIRING_FAILURE='verify control-plane-install-live' \
  DIM_VERIFICATION_REAL_WIRING_LOG="$real_wiring_log" \
  DIM_VERIFICATION_INTERNAL_STAGE=common-full \
  PATH="$fake_bin:$PATH" \
  bash "$script_dir/kvm-guest-verification-smoke.bash" >"$nested_failure_output" 2>&1 || nested_failure_status=$?
test "$nested_failure_status" -eq 1
grep -Fq 'FAIL control-plane-install-live status=7' "$nested_failure_output"
grep -Fqx "verification-stage-summary passed=7 failed=1 blocked=0 logs=$nested_failure_logs" \
  "$nested_failure_output"
test -d "$nested_failure_logs"
test -f "$nested_failure_logs/control-plane-install-live.log"
test "$(stat -c '%a' "$nested_failure_logs/control-plane-install-live.log")" = 600
! grep -R -Fq 'leaked internal verification stage:' \
  "$nested_failure_output" "$nested_failure_logs"
