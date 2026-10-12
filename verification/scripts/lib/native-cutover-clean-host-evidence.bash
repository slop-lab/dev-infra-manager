#!/usr/bin/env bash

cutover_capture_image_evidence() {
  local terminal="$1" ordinary_runner ordinary_job qemu_runner qemu_job control ordinary
  ordinary_runner="$(jq -er '.ordinary.event.payload.descriptor.runnerBaseImage' <<<"$terminal")"
  ordinary_job="$(jq -er '.ordinary.event.payload.descriptor.jobImage' <<<"$terminal")"
  qemu_runner="$(jq -er '.qemu.event.payload.descriptor.runnerBaseImage' <<<"$terminal")"
  qemu_job="$(jq -er '.qemu.event.payload.descriptor.jobImage' <<<"$terminal")"
  control="$(cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- \
    "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}" "${CUTOVER_CONFIG[QEMU_HOST_CONFIG]}" \
    "${CUTOVER_CONFIG[NATIVE_GIT_CONTAINER]}" "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" \
    "$qemu_runner" "$qemu_job" <<'REMOTE'
set -euo pipefail
install_config="$1"; qemu_config="$2"; native_container="$3"; ordinary_container="$4"; runner="$5"; job="$6"
images="$(jq -c '[.nativeGit.image,.ordinaryCi.image]' "$install_config")"
configured_qemu="$(jq -c '[.capacities[] | .runnerBaseImage,.jobBaseImage] | unique' "$qemu_config")"
[[ "$(jq -nr --arg runner "$runner" --arg job "$job" --argjson configured "$configured_qemu" \
  '([$runner,$job] | all(. as $image | $configured | index($image) != null))')" == true ]]
containers="$(docker container inspect "$native_container" "$ordinary_container" --format '{{json .Image}}' | jq -sc '.')"
qemu_ids="$(docker image inspect "$runner" "$job" --format '{{json .Id}}' | jq -sc '.')"
jq -cn --argjson controlPlane "$images" --arg runner "$runner" --arg job "$job" \
  --argjson qemuImageIds "$qemu_ids" --argjson containers "$containers" \
  '{controlPlane:$controlPlane,qemu:{runnerBaseImage:$runner,jobImage:$job,imageIds:$qemuImageIds},runningContainerImageIds:$containers}'
REMOTE
)"
  ordinary="$(cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" bash -s -- \
    "${CUTOVER_CONFIG[ORDINARY_HOST_CONFIG]}" "$ordinary_runner" "$ordinary_job" <<'REMOTE'
set -euo pipefail
host_id="$(jq -er '.hostId' "$1")"
image_ids="$(docker image inspect "$2" "$3" --format '{{json .Id}}' | jq -sc '.')"
jq -cn --arg hostId "$host_id" --arg runner "$2" --arg job "$3" --argjson imageIds "$image_ids" \
  '{hostId:$hostId,runnerBaseImage:$runner,jobImage:$job,imageIds:$imageIds}'
REMOTE
)"
  jq -cn --argjson control "$control" --argjson ordinary "$ordinary" \
    '{schemaVersion:1,controlQemu:$control,ordinary:$ordinary}'
}

cutover_promotion_ledger() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" docker exec --user 10001:10001 \
    "${CUTOVER_CONFIG[NATIVE_GIT_CONTAINER]}" node --input-type=module - "${CUTOVER_CONFIG[PROJECT_ID]}" <<'NODE'
import { DatabaseSync } from "node:sqlite";
const project = process.argv[2];
const database = new DatabaseSync("/var/lib/dim-native-git/native-idle.sqlite3", { readOnly: true });
const intent = database.prepare("SELECT count(*) count FROM native_project_root_promotion_intent WHERE project_id = ?").get(project);
const finalized = database.prepare("SELECT sequence, candidate_commit, candidate_tree FROM native_project_root_promotion_finalized WHERE project_id = ? ORDER BY sequence").all(project);
database.close();
process.stdout.write(`${JSON.stringify({ intent: intent.count, finalized })}\n`);
NODE
}

cutover_refresh_protected_root() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- "${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    "${CUTOVER_CONFIG[WORKSPACE_NAME]}" <<'REMOTE'
set -euo pipefail
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace restart "$2" >/dev/null
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace show "$2" --json
REMOTE
}
