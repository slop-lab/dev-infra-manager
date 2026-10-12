#!/usr/bin/env bash

matrix_select_profile() {
  local profile="$1" prefix="${1^^}"
  CUTOVER_PROFILE="$profile"
  CUTOVER_CONFIG[PROJECT_NAME]="${CUTOVER_CONFIG[${prefix}_PROJECT_NAME]}"
  CUTOVER_CONFIG[PROJECT_ID]="${CUTOVER_CONFIG[${prefix}_PROJECT_ID]}"
  CUTOVER_CONFIG[PROJECT_SOURCE]="${CUTOVER_CONFIG[${prefix}_PROJECT_SOURCE]}"
  CUTOVER_CONFIG[PROJECT_REF]="${CUTOVER_CONFIG[${prefix}_PROJECT_REF]}"
  CUTOVER_CONFIG[PROJECT_COMMIT]="${CUTOVER_CONFIG[${prefix}_PROJECT_COMMIT]}"
  CUTOVER_CONFIG[WORKSPACE_NAME]="${CUTOVER_CONFIG[${prefix}_WORKSPACE_NAME]}"
  CUTOVER_CONFIG[WORKSPACE_REPOSITORY]="${CUTOVER_CONFIG[${prefix}_WORKSPACE_REPOSITORY]}"
  CUTOVER_RUN_ID="${MATRIX_RUN_ID}-${profile}"
}

matrix_profile_source_preflight() {
  local arguments=() profile prefix
  for profile in empty ordinary qemu dual; do
    prefix="${profile^^}"
    arguments+=(
      "${CUTOVER_CONFIG[${prefix}_PROJECT_SOURCE]}"
      "${CUTOVER_CONFIG[${prefix}_PROJECT_REF]}"
      "${CUTOVER_CONFIG[${prefix}_PROJECT_COMMIT]}"
    )
  done
  arguments+=(
    "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}" "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}"
    "${CUTOVER_CONFIG[QEMU_SCHEDULER_CONFIG]}" "${CUTOVER_CONFIG[QEMU_HOST_ID]}"
    "${CUTOVER_CONFIG[QEMU_HOST_CONFIG]}"
  )
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- "${arguments[@]}" <<'REMOTE'
set -euo pipefail
for offset in 1 4 7 10; do
  source="${!offset}"
  ref_index=$((offset + 1)); commit_index=$((offset + 2))
  ref="${!ref_index}"; commit="${!commit_index}"
  [[ "$(git -C "$source" rev-parse --verify "$ref^{commit}")" == "$commit" ]]
  [[ -z "$(git -C "$source" status --porcelain=v1 --untracked-files=all)" ]]
  tree="$(git -C "$source" rev-parse "$ref^{tree}")"
  case "$offset" in 1) profile=empty;; 4) profile=ordinary;; 7) profile=qemu;; 10) profile=dual;; esac
  sources="$(jq -cn --argjson current "${sources:-[]}" --arg profile "$profile" --arg source "$source" \
    --arg ref "$ref" --arg commit "$commit" --arg tree "$tree" \
    '$current + [{profile:$profile,path:$source,ref:$ref,commit:$commit,tree:$tree}]')"
done
! systemctl --user is-active --quiet "${13}"
! systemctl --user is-active --quiet "${14}"
systemctl --user cat "${13}" | grep -F -- "dim ci native-qemu scheduler run ${15}" >/dev/null
systemctl --user cat "${14}" | grep -F -- "dim ci native-qemu host run ${16} ${17}" >/dev/null
printf '%s\n' "$sources"
REMOTE
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" bash -s -- "${CUTOVER_CONFIG[ORDINARY_UNIT]}" \
    "${CUTOVER_CONFIG[ORDINARY_HOST_CONFIG]}" <<'REMOTE'
set -euo pipefail
! systemctl --user is-active --quiet "$1"
systemctl --user cat "$1" | grep -F -- "dim ci native-root host run $2" >/dev/null
REMOTE
}

matrix_assert_ready_ci_stopped() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- \
    "${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}" "${CUTOVER_CONFIG[PROJECT_NAME]}" \
    "${CUTOVER_CONFIG[WORKSPACE_NAME]}" "${CUTOVER_CONFIG[PROJECT_COMMIT]}" \
    "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}" "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}" <<'REMOTE'
set -euo pipefail
project="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim project show "$2" --json)"
workspace="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace show "$3" --json)"
jq -e '.phase == "ready" and .runnable == true' <<<"$project" >/dev/null
jq -e --arg commit "$4" '.phase == "ready" and .rootCommit == $commit' <<<"$workspace" >/dev/null
! systemctl --user is-active --quiet "$5"
! systemctl --user is-active --quiet "$6"
jq -cn --argjson project "$project" --argjson workspace "$workspace" '{project:$project,workspace:$workspace}'
REMOTE
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" systemctl --user is-active --quiet \
    "${CUTOVER_CONFIG[ORDINARY_UNIT]}" && cutover_die "ordinary host became active before global CI start"
  return 0
}

matrix_ordinary_service_helper() {
  printf '%s/verification/scripts/lib/native-cutover-policy-matrix-ordinary-service.bash\n' \
    "${CUTOVER_CONFIG[CONTROL_SOURCE_ROOT]}"
}

matrix_stop_owned_ordinary_ci() {
  local helper baseline stopped
  helper="$(matrix_ordinary_service_helper)"
  baseline="$(cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash "$helper" inspect \
    "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}")"
  MATRIX_ORDINARY_CI_CONTAINER_ID="$(jq -er '.identity.containerId' <<<"$baseline")"
  MATRIX_ORDINARY_CI_STATE_SHA256="$(jq -er '.stateSha256' <<<"$baseline")"
  MATRIX_ORDINARY_CI_RESTORE_REQUIRED=1
  stopped="$(cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash "$helper" stop \
    "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}" \
    "$MATRIX_ORDINARY_CI_CONTAINER_ID" "$MATRIX_ORDINARY_CI_STATE_SHA256")"
  jq -cn --argjson before "$baseline" --argjson stopped "$stopped" '{before:$before,stopped:$stopped}'
}

matrix_assert_owned_ordinary_ci_stopped() {
  local helper
  [[ "$MATRIX_ORDINARY_CI_RESTORE_REQUIRED" -eq 1 ]] || cutover_die "ordinary service outage is not armed"
  helper="$(matrix_ordinary_service_helper)"
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash "$helper" stopped \
    "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}" \
    "$MATRIX_ORDINARY_CI_CONTAINER_ID"
}

matrix_restore_owned_ordinary_ci() {
  local helper restored
  [[ "$MATRIX_ORDINARY_CI_RESTORE_REQUIRED" -eq 1 ]] || return 0
  helper="$(matrix_ordinary_service_helper)"
  restored="$(cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash "$helper" start \
    "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}" \
    "$MATRIX_ORDINARY_CI_CONTAINER_ID" "$MATRIX_ORDINARY_CI_STATE_SHA256")" || return
  MATRIX_ORDINARY_CI_RESTORE_REQUIRED=0
  printf '%s\n' "$restored"
}

matrix_assert_owned_ordinary_ci_running() {
  local helper
  [[ "$MATRIX_ORDINARY_CI_RESTORE_REQUIRED" -eq 0 ]] || cutover_die "ordinary service remains stopped"
  helper="$(matrix_ordinary_service_helper)"
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash "$helper" inspect \
    "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}"
}

matrix_start_global_ci() {
  matrix_assert_owned_ordinary_ci_running
  CUTOVER_STARTED_QEMU_SCHEDULER=1
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" systemctl --user start "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}"
  cutover_wait_for_qemu_scheduler
  CUTOVER_STARTED_QEMU_HOST=1
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" systemctl --user start "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}"
  CUTOVER_STARTED_ORDINARY=1
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" systemctl --user start "${CUTOVER_CONFIG[ORDINARY_UNIT]}"
}

matrix_assert_review_profile() {
  local profile="$1" review="$2"
  jq -e --arg ordinary "${CUTOVER_CONFIG[ORDINARY_JOB]}" --arg qemu "${CUTOVER_CONFIG[QEMU_JOB]}" '
    .schemaVersion == 2 and .planning.status == "valid" and
    [.planning.jobs[] | {executionKind,jobName,evidenceClass}] == [
      {executionKind:"ordinary-sysbox",jobName:$ordinary,evidenceClass:"candidate-controlled"},
      {executionKind:"qemu",jobName:$qemu,evidenceClass:"candidate-controlled"}
    ] and [.events[] | {schemaVersion,type,executionKind,jobName,evidenceClass}] == [
      {schemaVersion:3,type:"dim.native.review-job.available",executionKind:"ordinary-sysbox",jobName:$ordinary,evidenceClass:"candidate-controlled"},
      {schemaVersion:3,type:"dim.native.review-job.available",executionKind:"qemu",jobName:$qemu,evidenceClass:"candidate-controlled"}
    ]
  ' <<<"$review" >/dev/null || cutover_die "$profile automatic envelope does not contain both current planned jobs/events"
  case "$profile" in
    empty)
      jq -e '.requiredJobs == []' <<<"$review" >/dev/null ||
        cutover_die "empty source snapshot does not select the empty quality policy"
      ;;
    ordinary)
      jq -e --arg job "${CUTOVER_CONFIG[ORDINARY_JOB]}" \
        '.requiredJobs == [{executionKind:"ordinary-sysbox",jobName:$job,evidenceClass:"candidate-controlled"}]' \
        <<<"$review" >/dev/null || cutover_die "ordinary source snapshot does not select exactly the ordinary job"
      ;;
    qemu)
      jq -e --arg job "${CUTOVER_CONFIG[QEMU_JOB]}" \
        '.requiredJobs == [{executionKind:"qemu",jobName:$job,evidenceClass:"candidate-controlled"}]' \
        <<<"$review" >/dev/null || cutover_die "QEMU source snapshot does not select exactly the QEMU job"
      ;;
    dual)
      jq -e --arg ordinary "${CUTOVER_CONFIG[ORDINARY_JOB]}" --arg qemu "${CUTOVER_CONFIG[QEMU_JOB]}" \
        '.requiredJobs == [{executionKind:"ordinary-sysbox",jobName:$ordinary,evidenceClass:"candidate-controlled"},
          {executionKind:"qemu",jobName:$qemu,evidenceClass:"candidate-controlled"}]' \
        <<<"$review" >/dev/null || cutover_die "dual source snapshot does not select exactly both configured jobs"
      ;;
  esac
}

matrix_stop_global_ci() {
  local failed=0
  if [[ "$CUTOVER_STARTED_QEMU_HOST" -eq 1 ]]; then
    if cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" systemctl --user stop "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}"; then
      CUTOVER_STARTED_QEMU_HOST=0
    else
      failed=1
    fi
  fi
  if [[ "$CUTOVER_STARTED_QEMU_SCHEDULER" -eq 1 ]]; then
    if cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" systemctl --user stop "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}"; then
      CUTOVER_STARTED_QEMU_SCHEDULER=0
    else
      failed=1
    fi
  fi
  if [[ "$CUTOVER_STARTED_ORDINARY" -eq 1 ]]; then
    if cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" systemctl --user stop "${CUTOVER_CONFIG[ORDINARY_UNIT]}"; then
      CUTOVER_STARTED_ORDINARY=0
    else
      failed=1
    fi
  fi
  return "$failed"
}

matrix_assert_quality_evidence() {
  local profile="$1" terminal="$2" ordinary_digest="$3" qemu_digest="$4"
  case "$profile" in
    empty) return 0 ;;
    ordinary)
      jq -e --arg digest "$ordinary_digest" \
        '.ordinary.result == "success" and .ordinary.digest == $digest' \
        <<<"$terminal" >/dev/null || cutover_die "ordinary quality-required evidence is missing or mismatched"
      ;;
    qemu)
      jq -e --arg digest "$qemu_digest" \
        '.qemu.result == "success" and .qemu.digest == $digest' \
        <<<"$terminal" >/dev/null || cutover_die "QEMU quality-required evidence is missing or mismatched"
      ;;
    dual)
      jq -e --arg ordinary "$ordinary_digest" --arg qemu "$qemu_digest" \
        '.ordinary.result == "success" and .ordinary.digest == $ordinary and
         .qemu.result == "success" and .qemu.digest == $qemu' \
        <<<"$terminal" >/dev/null || cutover_die "dual quality-required evidence is missing or mismatched"
      ;;
    *) cutover_die "unknown matrix profile '$profile'" 2 ;;
  esac
}

matrix_assert_executed_evidence() {
  local _profile="$1" terminal="$2" ordinary_digest="$3" qemu_digest="$4"
  jq -e --arg ordinary "$ordinary_digest" --arg qemu "$qemu_digest" '
    .ordinary.result == "success" and .ordinary.digest == $ordinary and
    .qemu.result == "success" and .qemu.digest == $qemu
  ' <<<"$terminal" >/dev/null || cutover_die "executed job evidence is incomplete or mismatched"
}

matrix_read_terminal_evidence() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" docker exec --user 10001:10001 \
    "${CUTOVER_CONFIG[NATIVE_GIT_CONTAINER]}" node --input-type=module - \
    "/var/lib/dim-native-git/${CUTOVER_CONFIG[PROJECT_ID]}/root.git" "$CUTOVER_REVIEW_ID" \
    "${CUTOVER_CONFIG[ORDINARY_JOB]}" "${CUTOVER_CONFIG[QEMU_JOB]}" <<'NODE'
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const [repository, reviewId, ordinaryJob, qemuJob] = process.argv.slice(2);
const output = {};
try {
  const root = join(repository, "dim-authoritative-statuses", "ordinary-sysbox", reviewId, ordinaryJob);
  const names = (await readdir(root)).filter((name) => /^[1-9][0-9]*\.json$/.test(name))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
  const event = JSON.parse(await readFile(join(root, names.at(-1)), "utf8"));
  if (event.schemaVersion !== 3 || event.payload?.executionKind !== "ordinary-sysbox"
    || event.payload?.reviewId !== reviewId || event.payload?.descriptor?.jobName !== ordinaryJob
    || event.payload?.stdout?.truncated !== false) process.exit(2);
  output.ordinary = { result: event.payload.result, digest: event.payload.stdout.sha256, event };
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
try {
  const state = JSON.parse(await readFile(join(repository, "dim-authoritative-qemu", "state.json"), "utf8"));
  const attempt = [...state.attempts].reverse().find((entry) => entry.reviewId === reviewId && entry.descriptor.jobName === qemuJob && entry.revokedAt === undefined);
  const event = state.statuses.find((entry) => entry.attemptId === attempt?.attemptId);
  if (state.schemaVersion !== 1 || event?.schemaVersion !== 1 || event.event?.schemaVersion !== 3
    || event.event?.payload?.executionKind !== "qemu" || event.event?.payload?.reviewId !== reviewId
    || event.event?.payload?.attemptId !== attempt?.attemptId
    || event.event?.payload?.descriptor?.jobName !== qemuJob
    || event.event?.payload?.stdout?.truncated !== false) process.exit(2);
  output.qemu = { result: event.result, digest: event.event.payload.stdout.sha256, event };
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
process.stdout.write(`${JSON.stringify(output)}\n`);
NODE
}

matrix_wait_for_evidence_scope() {
  local assertion="$1" profile="$2" deadline=$((SECONDS + 1800)) terminal
  local ordinary_digest="sha256:$(printf '%s\n' "${CUTOVER_CONFIG[ORDINARY_MARKER]}" | sha256sum | cut -d ' ' -f 1)"
  local qemu_digest="sha256:$(printf '%s\n' "${CUTOVER_CONFIG[QEMU_MARKER]}" | sha256sum | cut -d ' ' -f 1)"
  if [[ "$assertion" == matrix_assert_quality_evidence && "$profile" == empty ]]; then printf '{}\n'; return; fi
  while (( SECONDS < deadline )); do
    if terminal="$(matrix_read_terminal_evidence 2>/dev/null)" &&
      "$assertion" "$profile" "$terminal" "$ordinary_digest" "$qemu_digest"; then
      printf '%s\n' "$terminal"
      return
    fi
    sleep 5
  done
  cutover_die "timed out waiting for $profile $assertion terminal evidence"
}

matrix_capture_executed_images() {
  local terminal="$1"
  cutover_capture_image_evidence "$(jq -c '{ordinary:{event:.ordinary.event},qemu:.qemu.event}' <<<"$terminal")"
}

matrix_ref_state() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" docker exec --user 10001:10001 \
    "${CUTOVER_CONFIG[NATIVE_GIT_CONTAINER]}" bash -s -- \
    "/var/lib/dim-native-git/${CUTOVER_CONFIG[PROJECT_ID]}/root.git" <<'REMOTE'
set -euo pipefail
commit="$(git --git-dir "$1" rev-parse refs/heads/main)"
tree="$(git --git-dir "$1" rev-parse "$commit^{tree}")"
jq -cn --arg ref refs/heads/main --arg commit "$commit" --arg tree "$tree" '{ref:$ref,commit:$commit,tree:$tree}'
REMOTE
}

matrix_cleanup_profile() {
  matrix_stop_global_ci
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" env \
    "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    dim workspace discard "${CUTOVER_CONFIG[WORKSPACE_NAME]}" --yes
  MATRIX_WORKSPACE_CREATED=0
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s <<'REMOTE'
set -euo pipefail
[[ -z "$(docker container ls --all --quiet --filter label=dev.dim.native-qemu.claim)" ]]
shopt -s nullglob
residue=(/var/lib/dim-native-qemu-host/*/journal.json /var/lib/dim-native-qemu-host/*/*/)
[[ "${#residue[@]}" -eq 0 ]]
REMOTE
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" bash -s -- \
    "${CUTOVER_CONFIG[ORDINARY_STATE_DIRECTORY]}" <<'REMOTE'
set -euo pipefail
[[ -z "$(docker container ls --all --quiet --filter label=dim.kind=native-ordinary-runner)" ]]
shopt -s nullglob
residue=("$1"/*.json "$1"/work-* "$1"/.work-*.staging)
[[ "${#residue[@]}" -eq 0 ]]
REMOTE
}
