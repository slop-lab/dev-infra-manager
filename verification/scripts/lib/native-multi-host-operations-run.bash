#!/usr/bin/env bash

ops_install_candidate() {
  local target source
  for target in "${OPS_CONFIG[CONTROL_SSH]}" "${OPS_CONFIG[ORDINARY_SSH]}"; do
    if [[ "$target" == "${OPS_CONFIG[CONTROL_SSH]}" ]]; then source="${OPS_CONFIG[CONTROL_SOURCE_ROOT]}"
    else source="${OPS_CONFIG[ORDINARY_SOURCE_ROOT]}"; fi
    ops_ssh "$target" bash -s -- "$source" <<'REMOTE'
set -euo pipefail
cd -- "$1"
just install-local
REMOTE
  done
}

ops_install_control_plane() {
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" dim installer install control-plane --config \
    "${OPS_CONFIG[CONTROL_INSTALL_CONFIG]}"
}

ops_create_project_workspace() {
  local workspace_id
  OPS_WORKSPACE_CREATION_ATTEMPTED=1
  workspace_id="$(ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" bash -s -- "${OPS_CONFIG[PROJECT_NAME]}" \
    "${OPS_CONFIG[PROJECT_ID]}" "${OPS_CONFIG[PROJECT_SOURCE]}" "${OPS_CONFIG[PROJECT_REF]}" \
    "${OPS_CONFIG[PROJECT_COMMIT]}" "${OPS_CONFIG[REGISTRAR_CONNECTION]}" \
    "${OPS_CONFIG[IMPORTER_CONNECTION]}" "${OPS_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    "${OPS_CONFIG[WORKSPACE_NAME]}" <<'REMOTE'
set -euo pipefail
[[ "$(git -C "$3" rev-parse --verify "$4^{commit}")" == "$5" ]]
dim project bootstrap-native-root "$1" --project-id "$2" --source-repository "$3" --source-ref "$4" \
  --registrar-connection "$6" --importer-connection "$7" --git-executable /usr/bin/git --json >/dev/null
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$8" DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE="$7" \
  dim project create "$1" --json >/dev/null
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$8" dim workspace create "$1" "$9" --json >/dev/null
workspace="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$8" dim workspace show "$9" --json)"
jq -er --arg name "$9" --arg project "$1" --arg commit "$5" '
  select(.name == $name and .projectName == $project and .rootCommit == $commit) | .workspaceId |
  select(test("^[A-Za-z0-9_-]{43}$"))' <<<"$workspace"
REMOTE
  )"
  [[ "$workspace_id" =~ ^[A-Za-z0-9_-]{43}$ ]] || return 1
  OPS_WORKSPACE_ID="$workspace_id"
  OPS_WORKSPACE_CREATED=1
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" env \
    "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=${OPS_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    dim workspace show "${OPS_CONFIG[WORKSPACE_NAME]}" --json | jq -e --arg commit "${OPS_CONFIG[PROJECT_COMMIT]}" \
    '.phase == "ready" and .rootCommit == $commit' >/dev/null
}

ops_wait_scheduler() {
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" node --input-type=module - \
    "${OPS_CONFIG[QEMU_SCHEDULER_CONFIG]}" <<'NODE'
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`http://${host}:${config.port}/healthz`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    if (response.status === 200 && body.serviceId === config.serviceId && body.status === "ready") process.exit(0);
  } catch {}
  await delay(1000);
}
process.exit(2);
NODE
}

ops_start_services() {
  OPS_QEMU_SCHEDULER_ARMED=1
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user start "${OPS_CONFIG[QEMU_SCHEDULER_UNIT]}"
  ops_wait_scheduler
  OPS_QEMU_HOST_ARMED=1
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" systemctl --user start "${OPS_CONFIG[QEMU_HOST_UNIT]}"
  OPS_ORDINARY_ARMED=1
  ops_ssh "${OPS_CONFIG[ORDINARY_SSH]}" systemctl --user start "${OPS_CONFIG[ORDINARY_UNIT]}"
}

ops_read_protected_ref() {
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" env \
    "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=${OPS_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    dim workspace exec "${OPS_CONFIG[WORKSPACE_NAME]}" -- bash -s -- \
    "${OPS_CONFIG[WORKSPACE_REPOSITORY]}" "${OPS_CONFIG[PROJECT_REF]}" <<'REMOTE'
set -euo pipefail
refs_output="$(git -C "$1" ls-remote --refs origin "$2")" || { status=$?; exit "$status"; }
mapfile -t refs <<<"$refs_output"
[[ "${#refs[@]}" -eq 1 ]]
read -r commit ref extra <<<"${refs[0]}"
[[ "$ref" == "$2" && -z "${extra:-}" && "$commit" =~ ^[0-9a-f]{40}$ ]]
printf '%s\n' "$commit"
REMOTE
}

ops_create_proposal() {
  local attempt="$1"
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" bash -s -- "${OPS_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    "${OPS_CONFIG[WORKSPACE_NAME]}" "${OPS_CONFIG[WORKSPACE_REPOSITORY]}" "$OPS_RUN_ID" "$attempt" <<'REMOTE'
set -euo pipefail
show="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace show "$2" --json)"
workspace_id="$(jq -er '.workspaceId' <<<"$show")"
proposal="refs/heads/proposals/$workspace_id/native-operations-$4-$5"
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace exec "$2" -- bash -s -- "$3" "$proposal" "$4" "$5" <<'INNER'
set -euo pipefail
repository="$1"; proposal="$2"; run_id="$3"; attempt="$4"
git -C "$repository" config user.name 'DIM native operations'
git -C "$repository" config user.email 'native-operations@dim.invalid'
git -C "$repository" switch -C "native-operations-$run_id-$attempt" origin/HEAD >/dev/null 2>&1 ||
  git -C "$repository" switch -C "native-operations-$run_id-$attempt"
printf 'native operations %s attempt %s\n' "$run_id" "$attempt" >"$repository/native-operations-marker.txt"
git -C "$repository" add native-operations-marker.txt
git -C "$repository" commit -m "native operations $run_id attempt $attempt" >/dev/null
candidate="$(git -C "$repository" rev-parse HEAD)"; tree="$(git -C "$repository" rev-parse 'HEAD^{tree}')"
git -C "$repository" push origin "HEAD:$proposal"
jq -cn --arg proposalRef "$proposal" --arg candidateCommit "$candidate" --arg candidateTree "$tree" \
  '{proposalRef:$proposalRef,candidateCommit:$candidateCommit,candidateTree:$candidateTree}'
INNER
REMOTE
}

ops_execute_attempt() {
  local attempt="$1" proposal envelope terminal
  proposal="$(ops_create_proposal "$attempt")" || return
  envelope="$(ops_read_envelope "$proposal")" || return
  terminal="$(ops_wait_terminal_evidence "$envelope")" || return
  jq -cn --argjson proposal "$proposal" --argjson envelope "$envelope" --argjson terminal "$terminal" \
    '$proposal + {reviewId:$envelope.reviewId,expectedProtectedHead:$envelope.expectedProtectedHead,terminal:$terminal}'
}

ops_execute() {
  local before after first second
  ops_install_candidate
  ops_install_control_plane
  ops_create_project_workspace
  ops_start_services
  before="$(ops_read_protected_ref)" || return
  [[ "$before" == "${OPS_CONFIG[PROJECT_COMMIT]}" ]] || ops_die 'protected ref differs before operations'
  first="$(ops_execute_attempt 1)" || return
  after="$(ops_read_protected_ref)" || return
  [[ "$after" == "$before" ]] || ops_die 'protected ref changed after first CI run'
  ops_wait_idle
  ops_restart_services
  second="$(ops_execute_attempt 2)" || return
  after="$(ops_read_protected_ref)" || return
  [[ "$after" == "$before" ]] || ops_die 'protected ref changed after second CI run'
  ops_wait_idle
  jq -cn --argjson first "$first" --argjson second "$second" '[ $first, $second ]' >"$OPS_EVIDENCE/attempts.json"
  jq -e 'length == 2 and .[0].proposalRef != .[1].proposalRef and
    .[0].candidateCommit != .[1].candidateCommit and .[0].reviewId != .[1].reviewId' \
    "$OPS_EVIDENCE/attempts.json" >/dev/null || ops_die 'attempt identities were not unique'
}
