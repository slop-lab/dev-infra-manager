nested_cancel_driver="$work_dir/nested-cancel-driver.bash"
nested_cancel_output="$work_dir/nested-cancel.out"
nested_cancel_logs="$work_dir/nested-cancel.logs"
nested_cancel_inner_logs="$work_dir/nested-cancel-inner.logs"
nested_cancel_pids="$work_dir/nested-cancel.pids"
nested_cancel_descendants="$work_dir/nested-cancel.descendants"
nested_cancel_root_pgid_file="$work_dir/nested-cancel-root.pgid"
nested_cancel_trace="$work_dir/nested-cancel.trace"
cat >"$nested_cancel_driver" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$script_dir/lib/verification-stage-runner.bash"
DIM_VERIFICATION_STAGE_ENTRYPOINT="$script_dir/kvm-guest-verification-smoke.bash"
export DIM_VERIFICATION_STAGE_ENTRYPOINT
verification_stage_register common-full unused ""
verification_stage_register non-root-ci unused ""
verification_stage_run
EOF
chmod 0700 "$nested_cancel_driver"
nested_cancel_status=0
DIM_FULL_DEVELOPMENT_LOG_ROOT="$nested_cancel_inner_logs" \
  DIM_KVM_SKIP_TRUSTED_WORKSPACE=1 \
  DIM_VERIFICATION_ASSERT_SELECTOR_ABSENT=1 \
  DIM_VERIFICATION_EXPECTED_LOG_ROOT="$nested_cancel_logs" \
  DIM_VERIFICATION_FULL_DEVELOPMENT_ENTRYPOINT="$script_dir/full-development-smoke.bash" \
  DIM_VERIFICATION_LOG_ROOT="$nested_cancel_logs" \
  DIM_VERIFICATION_LOG_ROOT_TRACE="$real_wiring_root_trace" \
  DIM_VERIFICATION_NESTED_CANCEL=1 \
  DIM_VERIFICATION_NESTED_CANCEL_DESCENDANTS="$nested_cancel_descendants" \
  DIM_VERIFICATION_NESTED_CANCEL_PIDS="$nested_cancel_pids" \
  DIM_VERIFICATION_NESTED_CANCEL_ROOT_PGID="$nested_cancel_root_pgid_file" \
  DIM_VERIFICATION_NESTED_CANCEL_TRACE="$nested_cancel_trace" \
  DIM_VERIFICATION_NESTED_CHAIN=1 \
  DIM_VERIFICATION_REAL_WIRING_LOG="$real_wiring_log" \
  PATH="$fake_bin:$PATH" \
  "$nested_cancel_driver" >"$nested_cancel_output" 2>&1 &
nested_cancel_runner=$!
for _ in $(seq 1 200); do
  [[ ! -s "$nested_cancel_pids" ]] || break
  kill -0 "$nested_cancel_runner" 2>/dev/null || break
  sleep 0.05
done
test -s "$nested_cancel_pids"
read -r nested_stage_pid nested_child_pid nested_grandchild_pid <"$nested_cancel_pids"
read -r -a nested_stage_stat <"/proc/$nested_stage_pid/stat"
nested_stage_pgid="${nested_stage_stat[4]}"
read -r -a nested_child_stat <"/proc/$nested_child_pid/stat"
read -r -a nested_grandchild_stat <"/proc/$nested_grandchild_pid/stat"
nested_cancel_root_pgid="$(<"$nested_cancel_root_pgid_file")"
test "$nested_stage_pgid" = "$nested_cancel_root_pgid"
test "${nested_child_stat[4]}" = "$nested_cancel_root_pgid"
test "${nested_grandchild_stat[4]}" = "$nested_cancel_root_pgid"
kill -TERM "$nested_cancel_runner"
wait "$nested_cancel_runner" || nested_cancel_status=$?
nested_cancel_orphaned=false
for _ in $(seq 1 100); do
  if [[ ! -e "/proc/$nested_stage_pid" && ! -e "/proc/$nested_child_pid" \
    && ! -e "/proc/$nested_grandchild_pid" ]]; then
    break
  fi
  sleep 0.05
done
if [[ -e "/proc/$nested_stage_pid" || -e "/proc/$nested_child_pid" \
  || -e "/proc/$nested_grandchild_pid" ]]; then
  nested_cancel_orphaned=true
  kill -KILL -- "-$nested_stage_pgid" 2>/dev/null || true
  kill -KILL "$nested_stage_pid" "$nested_child_pid" "$nested_grandchild_pid" 2>/dev/null || true
fi
test "$nested_cancel_status" -eq 143
test "$nested_cancel_orphaned" = false
grep -Fqx 'cleanup-start status=143' "$nested_cancel_trace"
grep -Fqx 'cleanup-done status=143' "$nested_cancel_trace"
! grep -Fq 'follower-ran' "$nested_cancel_trace"
test ! -e "/proc/$nested_stage_pid"
test ! -e "/proc/$nested_child_pid"
test ! -e "/proc/$nested_grandchild_pid"
invalid_internal_status=0
DIM_VERIFICATION_LOG_ROOT="$full_internal_logs" \
  DIM_VERIFICATION_INTERNAL_STAGE=missing \
  bash "$script_dir/full-development-smoke.bash" >/dev/null 2>&1 || invalid_internal_status=$?
test "$invalid_internal_status" -eq 2
missing_root_status=0
/usr/bin/env -u DIM_VERIFICATION_LOG_ROOT \
  DIM_VERIFICATION_INTERNAL_STAGE=native-idle-service-images \
  /usr/bin/bash "$script_dir/full-development-smoke.bash" \
  >"$work_dir/full-missing-root.out" 2>&1 || missing_root_status=$?
test "$missing_root_status" -eq 2
grep -Fqx 'internal verification stage requires an existing DIM_VERIFICATION_LOG_ROOT' \
  "$work_dir/full-missing-root.out"
missing_kvm_root_status=0
/usr/bin/env -u DIM_VERIFICATION_LOG_ROOT \
  DIM_VERIFICATION_INTERNAL_STAGE=common-full \
  /usr/bin/bash "$script_dir/kvm-guest-verification-smoke.bash" \
  >"$work_dir/kvm-missing-root.out" 2>&1 || missing_kvm_root_status=$?
test "$missing_kvm_root_status" -eq 2
grep -Fqx 'internal verification stage requires an existing DIM_VERIFICATION_LOG_ROOT' \
  "$work_dir/kvm-missing-root.out"

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
