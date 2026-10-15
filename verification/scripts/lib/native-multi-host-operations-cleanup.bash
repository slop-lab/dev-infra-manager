#!/usr/bin/env bash

ops_invocation_ids() {
  local control ordinary
  control="$(ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user show --property=InvocationID --value \
    "${OPS_CONFIG[QEMU_SCHEDULER_UNIT]}" "${OPS_CONFIG[QEMU_HOST_UNIT]}")" || return
  ordinary="$(ops_ssh "${OPS_CONFIG[ORDINARY_SSH]}" systemctl --user show --property=InvocationID --value \
    "${OPS_CONFIG[ORDINARY_UNIT]}")" || return
  jq -Rn --arg control "$control" --arg ordinary "$ordinary" '
    def ids: split("\n") | map(select(length > 0));
    ($control | ids) as $controlIds | ($ordinary | ids) as $ordinaryIds |
    if ($controlIds | length) != 2 or ($ordinaryIds | length) != 1 or
      any(($controlIds + $ordinaryIds)[]; test("^[0-9a-f]{32}$") | not)
    then error("invalid systemd InvocationID set")
    else {scheduler:$controlIds[0],qemuHost:$controlIds[1],ordinary:$ordinaryIds[0]} end'
}

ops_assert_owned_idle() {
  local failed=0
  if ! ops_assert_qemu_idle "${OPS_CONFIG[CONTROL_SSH]}" "${OPS_CONFIG[QEMU_HOST_CONFIG]}" \
    "${OPS_CONFIG[QEMU_HOST_ID]}"; then failed=1; fi
  if ! ops_ssh "${OPS_CONFIG[ORDINARY_SSH]}" bash -s -- "${OPS_CONFIG[ORDINARY_STATE_DIRECTORY]}" <<'REMOTE'
set -euo pipefail
[[ -z "$(docker container ls -aq --filter label=dim.kind=native-ordinary-runner)" ]]
shopt -s nullglob; residue=("$1"/*.json "$1"/work-* "$1"/.work-*.staging); ((${#residue[@]} == 0))
REMOTE
  then failed=1; fi
  return "$failed"
}

ops_wait_idle() {
  local deadline=$((SECONDS + 300))
  while ((SECONDS < deadline)); do
    if ops_assert_owned_idle 2>/dev/null; then return 0; fi
    sleep 5
  done
  printf 'native-multi-host-operations: timed out waiting for configured claims and journals to clean\n' >&2
  return 1
}

ops_restart_services() {
  local before after
  before="$(ops_invocation_ids)" || return
  ops_ssh "${OPS_CONFIG[ORDINARY_SSH]}" systemctl --user stop "${OPS_CONFIG[ORDINARY_UNIT]}"
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user stop "${OPS_CONFIG[QEMU_HOST_UNIT]}"
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user stop "${OPS_CONFIG[QEMU_SCHEDULER_UNIT]}"
  if ! ops_assert_owned_idle; then
    printf 'native-multi-host-operations: post-stop claims or journals remain; restart cleanliness is uncertain\n' >&2
    return 125
  fi
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user start "${OPS_CONFIG[QEMU_SCHEDULER_UNIT]}"
  ops_wait_scheduler
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user start "${OPS_CONFIG[QEMU_HOST_UNIT]}"
  ops_ssh "${OPS_CONFIG[ORDINARY_SSH]}" systemctl --user start "${OPS_CONFIG[ORDINARY_UNIT]}"
  after="$(ops_invocation_ids)" || return
  jq -ne --argjson before "$before" --argjson after "$after" '
    $before.scheduler != $after.scheduler and $before.qemuHost != $after.qemuHost and
    $before.ordinary != $after.ordinary' >/dev/null || ops_die 'all three systemd InvocationIDs must change'
  jq -cn --argjson before "$before" --argjson after "$after" '{before:$before,after:$after}' \
    >"$OPS_EVIDENCE/restart-invocation-ids.json"
}

ops_stop_armed_services() {
  local failed=0
  if [[ "${OPS_ORDINARY_ARMED:-0}" -eq 1 ]]; then
    if ops_ssh "${OPS_CONFIG[ORDINARY_SSH]}" systemctl --user stop "${OPS_CONFIG[ORDINARY_UNIT]}"; then
      OPS_ORDINARY_ARMED=0
    else failed=1; fi
  fi
  if [[ "${OPS_QEMU_HOST_ARMED:-0}" -eq 1 ]]; then
    if ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user stop "${OPS_CONFIG[QEMU_HOST_UNIT]}"; then
      OPS_QEMU_HOST_ARMED=0
    else failed=1; fi
  fi
  if [[ "${OPS_QEMU_SCHEDULER_ARMED:-0}" -eq 1 ]]; then
    if ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user stop "${OPS_CONFIG[QEMU_SCHEDULER_UNIT]}"; then
      OPS_QEMU_SCHEDULER_ARMED=0
    else failed=1; fi
  fi
  return "$failed"
}

ops_discard_owned_workspace() {
  local status
  [[ "${OPS_WORKSPACE_CREATION_ATTEMPTED:-0}" -eq 1 ]] || return 0
  if ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" bash -s -- \
    "${OPS_CONFIG[CONTROL_PLANE_CONNECTION]}" "${OPS_CONFIG[WORKSPACE_NAME]}" \
    "${OPS_CONFIG[PROJECT_NAME]}" "${OPS_WORKSPACE_ID:-}" <<'REMOTE'
set -euo pipefail
# workspace cleanup identity
if workspace="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace show "$2" --json 2>/dev/null)"; then
  jq -e --arg name "$2" --arg project "$3" --arg id "$4" '
    .name == $name and .projectName == $project and ($id == "" or .workspaceId == $id)' <<<"$workspace" >/dev/null
  DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace discard "$2" --yes
else
  workspaces="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace list --json)"
  jq -e --arg name "$2" 'all(.[]; .name != $name)' <<<"$workspaces" >/dev/null
fi
REMOTE
  then :
  else status=$?; return "$status"
  fi
  OPS_WORKSPACE_CREATED=0
  OPS_WORKSPACE_CREATION_ATTEMPTED=0
  OPS_WORKSPACE_ID=''
  return 0
}

ops_cleanup_exact() {
  local failed=0
  ops_stop_armed_services || failed=1
  ops_discard_owned_workspace || failed=1
  ops_assert_owned_idle || failed=1
  if [[ "$failed" -ne 0 ]]; then
    printf 'native-multi-host-operations: cleanup ownership or completion is uncertain\n' >&2
    return 125
  fi
  OPS_CLEANUP_COMPLETE=1
}

ops_publish_passed() {
  local attempts="$1" temporary="$OPS_EVIDENCE/.OPS-PASSED.$$.tmp"
  [[ "${OPS_CLEANUP_COMPLETE:-0}" -eq 1 ]] || ops_die 'refusing OPS-PASSED before exact cleanup'
  if grep -R -E -i '"(password|credential|token|authorization)"[[:space:]]*:' "$OPS_EVIDENCE" >/dev/null; then
    ops_die 'credential-bearing material reached the evidence directory'
  fi
  jq -cn --arg commit "${OPS_CONFIG[EXPECTED_COMMIT]}" --arg root "${OPS_CONFIG[PROJECT_COMMIT]}" \
    --argjson attempts "$attempts" '{schemaVersion:1,result:"operations-passed",
      scope:"prestable-two-node-control-qemu-plus-ordinary-operations",softwareCommit:$commit,
      protectedRoot:$root,attempts:$attempts,cleanup:"exact-run-owned-resources-clean",
      retainedState:"native Project and control plane retained for explicit disposal",
      fullReleaseGate:"not-satisfied",humanApproval:false,protectedWrite:false,
      notVerified:["stable-acceptance","human-approval","promotion-cas","whole-host-reboot",
        "in-flight-crash-matrix","traffic-inspection","physical-node-independence"]}' >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$OPS_EVIDENCE/OPS-PASSED"
}

ops_cleanup_trap() {
  local original="$1"
  trap - EXIT HUP INT TERM
  if [[ "${OPS_CLEANUP_COMPLETE:-0}" -eq 0 ]]; then
    ops_cleanup_exact || exit 125
  fi
  exit "$original"
}
