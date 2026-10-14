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
printf 'child-signal exit=%s commands=%s\n' \
  "$signal_status" "$(tr '\n' ',' <"$signal_execution")"
grep -E '^(FAIL backend|BLOCKED|verification-stage-summary)' "$signal_output"
printf 'cleanup-cancel exit=%s child=%s commands=%s\n' \
  "$cleanup_cancel_status" "$cleanup_cancel_child" "$(tr '\n' ',' <"$cleanup_cancel_execution")"
grep -E '^(fixture-body-status|FAIL backend|BLOCKED|verification-stage-summary)' \
  "$cleanup_cancel_output"
printf 'fault-injection case=cancel exit=%s child=%s descendant=%s commands=%s\n' \
  "$cancel_status" "$cancel_child" "$cancel_descendant" "$(tr '\n' ',' <"$cancel_execution")"
grep -E '^(FAIL backend|BLOCKED|verification-stage-summary)' "$cancel_output"
printf 'launch-window-cancel exit=%s leader=%s commands=%s\n' \
  "$launch_status" "$launch_pid" "$(tr '\n' ',' <"$launch_execution")"
grep -E '^(FAIL source|BLOCKED|verification-stage-summary)' "$launch_output"
printf 'real-phase-wiring outer-status=%s commands=%s\n' \
  "$real_wiring_status" "$real_wiring_commands"
printf 'internal-log-roots full=%s kvm=%s missing-full=%s missing-kvm=%s\n' \
  "$full_internal_logs" "$kvm_internal_logs" "$missing_root_status" "$missing_kvm_root_status"
printf 'nested-real-phase-wiring success-summary=%s failure-status=%s failure-summary=%s\n' \
  "$(grep -F 'verification-stage-summary' "$nested_success_output")" \
  "$nested_failure_status" \
  "$(grep -F 'verification-stage-summary' "$nested_failure_output")"
grep -E '^PASS (source-tools|docker-ready|backend-ready|native-idle-service-images|control-plane-install-live|workspace-user-setup|stateful-development|self-development) status=0' \
  "$nested_success_output"
printf 'nested-cancel status=%s pgid=%s stage=%s child=%s grandchild=%s orphaned=%s trace=%s\n' \
  "$nested_cancel_status" "$nested_cancel_root_pgid" "$nested_stage_pid" "$nested_child_pid" "$nested_grandchild_pid" \
  "$nested_cancel_orphaned" "$(tr '\n' ',' <"$nested_cancel_trace")"
printf 'qemu-mode-validation probe=%d mutual-exclusion=%d cache-prerequisite=%d\n' 2 2 2
printf 'verification-stage-runner-test-ok\n'
